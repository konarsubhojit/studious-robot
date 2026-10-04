/**
 * Unit tests for the cross-instance message bus and the Redis-backed store
 * bundle.  No live Redis is required: the Redis paths are exercised with an
 * in-memory fake that honours the small slice of the `node-redis` contract the
 * bus and adapter wiring depend on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryMessageBus, createRedisMessageBus } from '../src/messageBus.ts';
import { createRedisPgStores } from '../src/stores/index.ts';
import { STORE_NAMES } from '../src/stores/contracts.ts';
import { asSocketIoAdapter, asSocketIoServer, closeTestServer, listenOnRandomPort, readJson } from './helpers.ts';
import { createStores } from '../src/stores/index.ts';
import { createServer, CALL_TRANSITION_CHANNEL } from '../src/index.ts';

/** Resolve after pending `setImmediate`/microtasks so async delivery lands. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A shared in-memory Pub/Sub broker plus a `node-redis`-shaped client factory.
 * `duplicate()` returns a new client bound to the same broker.
 */
function createFakeRedis() {
  const broker: {
      subs: Map<string, Set<(message: string, channel: string) => void>>;
      published: { channel: string; message: string; }[];
      values: Map<string, string>;
      sets: Map<string, Set<string>>;
  } = { subs: new Map(), published: [], values: new Map(), sets: new Map() };

  function setFor(key: string): Set<string> {
    let values = broker.sets.get(key);
    if (!values) {
      values = new Set();
      broker.sets.set(key, values);
    }
    return values;
  }

  function isTerminal(status: string): boolean {
    return ['ended', 'declined', 'missed', 'busy', 'unreachable'].includes(status);
  }

  async function evaluateSave(keys: string[], args: string[]) {
    const call = JSON.parse(args[0]);
    broker.values.set(keys[0], JSON.stringify(call));
    const active = new Set((call.participants ?? [])
      .filter((participant: { state: string }) => ['joined', 'ringing', 'invited'].includes(participant.state))
      .map((participant: { userId: string }) => participant.userId));
    if (!call.participants?.length) {
      active.add(call.callerId);
      active.add(call.calleeId);
    }
    for (let index = 1; index < keys.length; index++) {
      const userId = args[index + 3];
      const callId = args[3];
      if (args[2] === '1' || !active.has(userId)) {
        setFor(keys[index]).delete(callId);
      } else {
        setFor(keys[index]).add(callId);
      }
    }
    return 1;
  }

  async function evaluateTransition(keys: string[], args: string[]) {
    const raw = broker.values.get(keys[0]);
    if (!raw) return JSON.stringify({ ok: false, error: 'not_found' });
    const call = JSON.parse(raw);
    if (call.status === args[1]) return JSON.stringify({ ok: true, idempotent: true, call });
    if (call.status !== args[0]) return JSON.stringify({ ok: false, error: 'stale_call_state' });
    call.status = args[1];
    call.updatedAt = args[2];
    if (args[3]) call.endReason = args[3];
    broker.values.set(keys[0], JSON.stringify(call));
    if (isTerminal(call.status)) {
      for (const key of keys.slice(1)) setFor(key).clear();
    }
    return JSON.stringify({ ok: true, idempotent: false, call });
  }

  async function evaluateList(key: string) {
    const calls: any[] = [];
    for (const callId of [...setFor(key)]) {
      const raw = broker.values.get(`signaling:call:${callId}`);
      if (!raw) {
        setFor(key).delete(callId);
        continue;
      }
      const call = JSON.parse(raw);
      if (isTerminal(call.status)) setFor(key).delete(callId);
      else calls.push(call);
    }
    return JSON.stringify(calls);
  }

  async function evaluate(script: string, keys: string[], args: string[]) {
    if (script.includes('local participants = {}')) return evaluateSave(keys, args);
    if (script.includes('local fromStatus = ARGV[1]')) return evaluateTransition(keys, args);
    if (script.includes("local ids = redis.call('SMEMBERS'")) return evaluateList(keys[0]);
    throw new Error('unexpected Redis script');
  }

  function makeClient() {
    return {
      connected: false,
      quit_called: false,
      on() {
        /* no-op error listener hook */
      },
      async connect() {
        this.connected = true;
      },
      async quit() {
        this.quit_called = true;
      },
      async get(key: string) {
        return broker.values.get(key) ?? null;
      },
      async set(key: string, value: string) {
        broker.values.set(key, value);
        return 'OK';
      },
      async del(key: string) {
        return broker.values.delete(key) ? 1 : 0;
      },
      async sAdd(key: string, member: string) {
        const values = setFor(key);
        const size = values.size;
        values.add(member);
        return values.size - size;
      },
      async sRem(key: string, member: string) {
        return setFor(key).delete(member) ? 1 : 0;
      },
      async sMembers(key: string) {
        return [...setFor(key)];
      },
      async pExpire(_key: string, _ttl: number) {
        return true;
      },
      async eval(script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) {
        return evaluate(script, keys, args);
      },
      duplicate() {
        return makeClient();
      },
      async publish(channel: string, message: string) {
        broker.published.push({ channel, message });
        const set = broker.subs.get(channel);
        if (set) for (const listener of [...set]) listener(message, channel);
        return set ? set.size : 0;
      },
      async subscribe(channel: string, listener: (message: string, channel: string) => void) {
        if (!broker.subs.has(channel)) broker.subs.set(channel, new Set());
        broker.subs.get(channel)?.add(listener);
      },
      /** @param channel */
      async unsubscribe(channel: string) {
        broker.subs.delete(channel);
      },
    };
  }

  return { broker, makeClient };
}

// ─── Memory bus ────────────────────────────────────────────────────────────────

test('memory bus delivers published JSON messages to subscribers', async () => {
  const bus = createMemoryMessageBus();
  const received: { msg: any; channel: string; }[] = [];
  await bus.subscribe('chan', (msg, channel) => {
    received.push({ msg, channel });
  });

  await bus.publish('chan', { hello: 'world' });
  await tick();

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].msg, { hello: 'world' });
  assert.equal(received[0].channel, 'chan');
  await bus.close();
});

test('Redis call state indexes all active participants and clears their indexes on terminal transition', async () => {
  const { makeClient, broker } = createFakeRedis();
  const stores = await createRedisPgStores({
    createClient: makeClient,
    createAdapter: () => asSocketIoAdapter({}),
  });
  const callState = stores.callState;
  assert.ok(callState);
  assert.ok(callState.listActiveCallsForUser);
  const callId = '00000000-0000-0000-0000-000000000526';
  const participantUsers = ['caller', 'callee-one', 'callee-two'];
  try {
    const call = {
      callId,
      callerId: 'caller',
      calleeId: 'callee-one',
      status: 'ringing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      participants: [
        { userId: 'caller', state: 'joined' as const },
        { userId: 'callee-one', state: 'ringing' as const },
        { userId: 'callee-two', state: 'ringing' as const },
      ],
    };
    await callState.save(call);
    for (const userId of participantUsers) {
      assert.deepEqual([...broker.sets.get(`signaling:user:${userId}:calls`) ?? []], [callId]);
      assert.deepEqual(
        (await callState.listActiveCallsForUser!(userId)).map((record) => record.callId),
        [callId]
      );
    }

    await callState.save({
      ...call,
      participants: [
        ...call.participants.slice(0, 2),
        { userId: 'callee-two', state: 'declined' as const },
      ],
    });
    assert.deepEqual([...broker.sets.get('signaling:user:callee-two:calls') ?? []], []);
    assert.deepEqual([...broker.sets.get('signaling:user:callee-one:calls') ?? []], [callId]);

    const terminal = await callState.transitionAtomic({
      callId,
      fromStatus: 'ringing',
      toStatus: 'ended',
      reason: 'user_hangup',
    });
    assert.equal(terminal.ok, true);
    for (const userId of participantUsers) {
      assert.deepEqual([...broker.sets.get(`signaling:user:${userId}:calls`) ?? []], []);
      assert.deepEqual(await callState.listActiveCallsForUser!(userId), []);
    }
  } finally {
    await stores.close();
  }
});

test('memory bus fans out to multiple subscribers and supports unsubscribe', async () => {
  const bus = createMemoryMessageBus();
  const a: any[] = [];
  const b: any[] = [];
  const unsubA = await bus.subscribe('c', (m) => {
    a.push(m);
  });
  await bus.subscribe('c', (m) => {
    b.push(m);
  });

  await bus.publish('c', { n: 1 });
  await tick();
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);

  await unsubA();
  await bus.publish('c', { n: 2 });
  await tick();
  assert.equal(a.length, 1, 'unsubscribed handler stops receiving');
  assert.equal(b.length, 2);
  await bus.close();
});

test('memory bus does not deliver after close', async () => {
  const bus = createMemoryMessageBus();
  const received: any[] = [];
  await bus.subscribe('c', (m) => {
    received.push(m);
  });
  await bus.close();
  await bus.publish('c', { n: 1 });
  await tick();
  assert.equal(received.length, 0);
});

// ─── Redis bus (faked) ───────────────────────────────────────────────────────

test('redis bus requires both pub and sub clients', () => {
  assert.throws(() => createRedisMessageBus({ pub: {}, sub: null }), /required/);
});

test('redis bus publishes via pub and fans out one subscription per channel', async () => {
  const { makeClient, broker } = createFakeRedis();
  const bus = createRedisMessageBus({ pub: makeClient(), sub: makeClient() });

  const a: any[] = [];
  const b: any[] = [];
  await bus.subscribe('c', (m) => {
    a.push(m);
  });
  await bus.subscribe('c', (m) => {
    b.push(m);
  });

  // Only one underlying Redis subscription despite two local handlers.
  assert.equal(broker.subs.get('c')?.size, 1);

  await bus.publish('c', { v: 42 });
  assert.deepEqual(a[0], { v: 42 });
  assert.deepEqual(b[0], { v: 42 });
  assert.equal(broker.published.length, 1);

  await bus.close();
});

test('redis bus unsubscribes from Redis only when the last handler is removed', async () => {
  const { makeClient, broker } = createFakeRedis();
  const bus = createRedisMessageBus({ pub: makeClient(), sub: makeClient() });

  const unsub1 = await bus.subscribe('c', () => {});
  const unsub2 = await bus.subscribe('c', () => {});

  await unsub1();
  assert.ok(broker.subs.has('c'), 'still subscribed while a handler remains');

  await unsub2();
  assert.ok(!broker.subs.has('c'), 'unsubscribed after last handler removed');

  await bus.close();
});

// ─── createRedisPgStores ─────────────────────────────────────────────────────

test('createRedisPgStores returns a complete store bundle plus bus/adapter/close', async () => {
  const { makeClient } = createFakeRedis();
  const adapterArgs: { value: { pub: unknown; sub: unknown; } | null; } = { value: null };
  const stores = await createRedisPgStores({
    createClient: makeClient,
    createAdapter: (pub: unknown, sub: unknown) => {
      adapterArgs.value = { pub, sub };
      return asSocketIoAdapter({ kind: 'fake-adapter' });
    },
  });

  // Every contract store is present and Map-shaped.
  for (const name of STORE_NAMES) {
    assert.ok(stores[name] instanceof Map, `${name} is a Map`);
  }

  assert.ok(stores.messageBus);
  assert.ok(stores.attachAdapter);
  assert.ok(stores.close);
  assert.equal(stores.messageBus.type, 'redis');
  assert.equal(typeof stores.attachAdapter, 'function');
  assert.equal(typeof stores.close, 'function');

  // attachAdapter wires the Socket.IO adapter onto the io server.
  let attached = null;
  const fakeIo = asSocketIoServer({
    /** @param a */
    adapter: (a: unknown) => {
      attached = a;
    },
  });
  stores.attachAdapter(fakeIo);
  assert.deepEqual(attached, { kind: 'fake-adapter' });
  assert.ok(
    adapterArgs.value?.pub && adapterArgs.value?.sub,
    'adapter built from its own client pair'
  );

  // The bundled bus works end-to-end.
  const received: any[] = [];
  await stores.messageBus.subscribe('c', (m) => {
    received.push(m);
  });
  await stores.messageBus.publish('c', { ok: true });
  assert.deepEqual(received[0], { ok: true });

  await stores.close();
});

// A second close must not issue commands against clients that already quit:
// node-redis rejects those with "The client is closed", which surfaced as an
// error on every graceful shutdown.
test('closing the redis store bundle twice quits each client only once', async () => {
  const { makeClient } = createFakeRedis();
  const quitAttempts: unknown[] = [];
  const stores = await createRedisPgStores({
    createClient: () => {
      const client = makeClient();
      const quit = client.quit.bind(client);
      client.quit = async () => {
        quitAttempts.push(client);
        if (client.quit_called) throw new Error('The client is closed');
        await quit();
      };
      return client;
    },
    createAdapter: () => asSocketIoAdapter({}),
  });

  const first = stores.close();
  assert.equal(stores.close(), first, 'repeated close() calls share one promise');
  await first;
  const attempts = quitAttempts.length;
  assert.ok(attempts > 0, 'the bundle quit its clients on the first close');

  await stores.close();
  assert.equal(quitAttempts.length, attempts, 'the second close issued no further quits');
});

test('createRedisPgStores throws without REDIS_URL or a client factory', async () => {
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    await assert.rejects(() => createRedisPgStores({}), /REDIS_URL/);
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test('createRedisPgStores can be injected as opts.stores into the in-memory contract', async () => {
  const { makeClient } = createFakeRedis();
  const bundle = await createRedisPgStores({
    createClient: makeClient,
    createAdapter: () => asSocketIoAdapter({}),
  });
  // The bundle satisfies createStores' contract validation.
  const validated = createStores({ stores: bundle });
  assert.equal(validated, bundle);
  assert.ok(bundle.close);
  await bundle.close();
});

// ─── createServer integration ────────────────────────────────────────────────

test('createServer publishes call-state transitions on the injected message bus', async () => {
  const bus = createMemoryMessageBus();
  const transitions: any[] = [];
  await bus.subscribe(CALL_TRANSITION_CHANNEL, (msg) => {
    transitions.push(msg);
  });

  const server = createServer({ messageBus: bus });
  assert.equal(server.messageBus, bus, 'bus exposed on the server');

  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any; }> {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await readJson(res) };
  }

  try {
    const caller = (await post('/session', { userId: 'alice', deviceId: 'd-a' })).body.sessionId;
    const callee = (await post('/session', { userId: 'bob', deviceId: 'd-b' })).body.sessionId;

    const created = await post('/calls', { calleeId: 'bob', sessionId: caller });
    assert.equal(created.status, 201);
    const { callId } = created.body;

    // ringing -> accepted should be published (initiate itself has no prior state).
    await post(`/calls/${callId}/accept`, { sessionId: callee });
    await tick();

    const accepted = transitions.find((t) => t.status === 'accepted');
    assert.ok(accepted, 'an accepted transition was published');
    assert.equal(accepted.callId, callId);
    assert.equal(accepted.previousStatus, 'ringing');
  } finally {
    await closeTestServer(server);
    await bus.close();
  }
});

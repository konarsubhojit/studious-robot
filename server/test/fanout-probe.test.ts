import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createFanoutProbe, describeTransport, FANOUT_PROBE_EVENT } from '../src/lib/fanoutProbe.ts';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { listenOnRandomPort, readJson } from './helpers.ts';

/**
 * A stand-in for one Socket.IO server whose adapter carries `serverSideEmit`
 * to the other members of a fleet.  `hub` is the shared transport: an emit on
 * one member is delivered to every *other* member, which is exactly the
 * contract `@socket.io/redis-adapter` implements over Redis Pub/Sub.
 */
function createFakeServer({ hub, transport }: { hub: EventEmitter; transport: string }) {
  const local = new EventEmitter();
  // Named so `describeTransport` reads the transport off the adapter instance,
  // the same way it does for the real RedisAdapter.
  const adapter = { constructor: { name: transport } } as unknown as object;
  const namespace = {
    adapter,
    serverSideEmit(event: string, payload: unknown) {
      hub.emit('emit', { from: local, event, payload });
    },
    on(event: string, handler: (payload: unknown) => void) {
      local.on(event, handler);
    },
    off(event: string, handler: (payload: unknown) => void) {
      local.off(event, handler);
    },
  };
  hub.on('emit', ({ from, event, payload }: { from: EventEmitter; event: string; payload: unknown }) => {
    if (from === local) return;
    local.emit(event, payload);
  });
  return { of: () => namespace };
}

test('describeTransport names the adapter in use', () => {
  assert.equal(describeTransport({ constructor: { name: 'Adapter' } } as object), 'in-memory');
  assert.equal(describeTransport({ constructor: { name: 'RedisAdapter' } } as object), 'redis-adapter');
  assert.equal(describeTransport({ constructor: { name: 'WebPubSubAdapter' } } as object), 'WebPubSubAdapter');
  assert.equal(describeTransport(null), 'unknown');
});

test('a process-local adapter is reported as not probing, and stays healthy', () => {
  const hub = new EventEmitter();
  const io = createFakeServer({ hub, transport: 'Adapter' });
  const probe = createFanoutProbe({ io, instanceId: '0', intervalMs: 50 });
  try {
    const status = probe.getStatus();
    assert.equal(status.transport, 'in-memory');
    assert.equal(status.probing, false);
    assert.deepEqual(status.peersSeen, []);
    assert.equal(status.lastPeerEventAgeMs, null);
    // A single-process deployment has no peers by construction; alerting on
    // that would fire on every developer laptop.
    assert.equal(status.healthy, true);
  } finally {
    probe.stop();
  }
});

test('instances on the same transport see each other and report healthy', () => {
  const hub = new EventEmitter();
  const first = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '0',
    intervalMs: 0,
  });
  const second = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '1',
    intervalMs: 0,
  });
  try {
    first.emitProbe();
    second.emitProbe();

    const firstStatus = first.getStatus();
    assert.equal(firstStatus.transport, 'redis-adapter');
    assert.equal(firstStatus.probing, true);
    assert.deepEqual(firstStatus.peersSeen, ['1']);
    assert.equal(typeof firstStatus.lastPeerEventAgeMs, 'number');
    assert.equal(firstStatus.mixedTransport, false);
    assert.equal(firstStatus.healthy, true);
    assert.deepEqual(second.getStatus().peersSeen, ['0']);
  } finally {
    first.stop();
    second.stop();
  }
});

test('an instance that hears from no peer is reported unhealthy', () => {
  const hub = new EventEmitter();
  const probe = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '0',
    intervalMs: 0,
  });
  try {
    probe.emitProbe();
    // This is the incident signature: Redis is configured (so `stateAffinity`
    // reads "shared") but nothing on the other side of the adapter answers.
    const status = probe.getStatus();
    assert.deepEqual(status.peersSeen, []);
    assert.equal(status.lastPeerEventAgeMs, null);
    assert.equal(status.healthy, false);
  } finally {
    probe.stop();
  }
});

test('a peer that stops probing is retired after the staleness window', () => {
  const hub = new EventEmitter();
  const first = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '0',
    intervalMs: 1_000,
    staleIntervals: 3,
  });
  const second = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '1',
    intervalMs: 0,
  });
  try {
    second.emitProbe();
    const seenAt = Date.now();
    assert.deepEqual(first.getStatus(seenAt + 2_000).peersSeen, ['1']);

    const stale = first.getStatus(seenAt + 4_000);
    assert.deepEqual(stale.peersSeen, []);
    assert.equal(stale.healthy, false);
  } finally {
    first.stop();
    second.stop();
  }
});

test('a peer on a different transport is reported as a mixed fleet', () => {
  const hub = new EventEmitter();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '));
  };
  const redis = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '0',
    intervalMs: 0,
  });
  const other = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'WebPubSubAdapter' }),
    instanceId: '1',
    intervalMs: 0,
  });
  try {
    other.emitProbe();
    const status = redis.getStatus();
    assert.deepEqual(status.peersSeen, ['1']);
    assert.equal(status.mixedTransport, true);
    // Peers are visible yet no socket can be reached across the split, so
    // "peer seen" alone must not be read as "fan-out works".
    assert.equal(status.healthy, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WebPubSubAdapter/);
    // Repeated probes from the same peer must not spam the log.
    other.emitProbe();
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    redis.stop();
    other.stop();
  }
});

test('stop() detaches the listener so a torn-down instance records nothing', () => {
  const hub = new EventEmitter();
  const first = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '0',
    intervalMs: 0,
  });
  const second = createFanoutProbe({
    io: createFakeServer({ hub, transport: 'RedisAdapter' }),
    instanceId: '1',
    intervalMs: 0,
  });
  first.stop();
  second.emitProbe();
  assert.deepEqual(first.getStatus().peersSeen, []);
  second.stop();
});

test('GET /health reports fan-out separately from stateAffinity', async () => {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  try {
    const body = await readJson(await fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(body.stateAffinity, 'sticky');
    assert.deepEqual(body.fanout, {
      transport: 'in-memory',
      probing: false,
      peersSeen: [],
      lastPeerEventAgeMs: null,
      healthy: true,
      mixedTransport: false,
    });
    assert.deepEqual(server.getFanoutStatus(), body.fanout);
  } finally {
    await new Promise((resolve) => server.httpServer.close(() => resolve(undefined)));
    await server.shutdown({ drainTimeoutMs: 0 });
  }
});

test('an attached cross-instance adapter is probed on a timer and stops on shutdown', async () => {
  const emits: unknown[] = [];
  const stores = Object.assign(createMemoryStores(), {
    attachAdapter: (io: import('socket.io').Server) => {
      const namespace = io.of('/');
      // Stand in for the Redis adapter: subclasses the in-memory one so the
      // rest of Socket.IO keeps working, named so the probe reports the
      // transport, and records what this instance announces.
      const InMemoryAdapter = namespace.adapter.constructor as new (nsp: unknown) => object;
      class RedisAdapter extends InMemoryAdapter {
        serverSideEmit(args: unknown[]) {
          emits.push(args[1]);
        }
      }
      Object.defineProperty(namespace, 'adapter', {
        value: new RedisAdapter(namespace),
        configurable: true,
      });
    },
  });
  const server = createServer({ stores, fanoutProbeIntervalMs: 20 });
  const port = await listenOnRandomPort(server.httpServer);
  try {
    const body = await readJson(await fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(body.fanout.transport, 'redis-adapter');
    assert.equal(body.fanout.probing, true);
    // Nothing answered this instance, which is precisely the state that must
    // not read as healthy just because Redis is configured.
    assert.equal(body.fanout.healthy, false);
    assert.ok(emits.length >= 1);
    assert.deepEqual(Object.keys(emits[0] as object).sort(), ['instanceId', 'transport', 'ts']);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(emits.length >= 2, 'probe should repeat on its interval');
  } finally {
    await server.shutdown({ drainTimeoutMs: 0 });
  }
  const afterShutdown = emits.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(emits.length, afterShutdown, 'shutdown must clear the probe timer');
});

test('the probe event name is namespaced so no client event can collide', () => {
  assert.equal(FANOUT_PROBE_EVENT, 'fanout.probe');
});

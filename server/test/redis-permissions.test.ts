/**
 * A Redis/Valkey ACL misconfiguration must degrade the fleet, not kill it.
 *
 * Production ran a Valkey user with key permissions but no channel
 * permissions (`resetchannels` is the default). The Socket.IO adapter
 * subscribes fire-and-forget, so the `NOPERM` rejection had no handler: the
 * process died on an unhandled `SimpleError` and systemd restart-looped both
 * VMs at once. These tests pin the guard that absorbs *permission* failures —
 * and only those, so an unreachable Redis keeps failing closed at startup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRedisPgStores } from '../src/stores/index.ts';
import {
  clearRedisDegradation,
  getRedisHealth,
  isRedisPermissionError,
  reportRedisPermissionFailure,
  resetRedisHealth,
} from '../src/lib/redisHealth.ts';
import { asSocketIoAdapter } from './helpers.ts';

/** Silence the operator-facing error logs these tests deliberately provoke. */
function captureConsoleError() {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  return { lines, restore: () => { console.error = original; } };
}

/**
 * A `node-redis`-shaped client whose subscribe/publish commands reject with
 * `failure`, mirroring how the driver reports a server-side `-NOPERM` reply.
 */
function makeFailingClient(failure: Error) {
  return {
    on() {},
    async connect() {},
    async quit() {},
    async subscribe() {
      throw failure;
    },
    async pSubscribe() {
      throw failure;
    },
    async publish() {
      throw failure;
    },
    async unsubscribe() {},
  };
}

test('isRedisPermissionError separates ACL refusals from transport failures', () => {
  assert.equal(isRedisPermissionError(new Error('NOPERM No permissions to access a channel')), true);
  assert.equal(isRedisPermissionError({ message: 'NOPERM No permissions to access a key' }), true);
  assert.equal(isRedisPermissionError(new Error('connect ECONNREFUSED 10.0.0.5:6379')), false);
  assert.equal(isRedisPermissionError(new Error('getaddrinfo ENOTFOUND cache.example')), false);
});

test('a permission failure is logged once, rate-limited after, and cleared on recovery', (t) => {
  const logs = captureConsoleError();
  resetRedisHealth();
  t.after(() => {
    logs.restore();
    resetRedisHealth();
  });

  const error = new Error('NOPERM No permissions to access a key');
  reportRedisPermissionFailure({ scope: 'call-sweep', error, remedy: 'grant `~*`' });
  reportRedisPermissionFailure({ scope: 'call-sweep', error, remedy: 'grant `~*`' });
  reportRedisPermissionFailure({ scope: 'call-sweep', error, remedy: 'grant `~*`' });

  assert.equal(logs.lines.length, 1, 'a failure repeating every 5s must not repeat every 5s in the log');
  assert.match(logs.lines[0], /call-sweep is DEGRADED/);
  assert.match(logs.lines[0], /NOPERM No permissions to access a key/);
  assert.match(logs.lines[0], /Remedy: grant `~\*`/);

  const health = getRedisHealth();
  assert.equal(health.degraded, true);
  assert.equal(health.issues.length, 1);
  assert.equal(health.issues[0].scope, 'call-sweep');
  assert.equal(health.issues[0].kind, 'permission');
  assert.equal(health.issues[0].occurrences, 3);
  assert.equal(typeof health.issues[0].since, 'string');

  clearRedisDegradation('call-sweep');
  assert.deepEqual(getRedisHealth(), { degraded: false, issues: [] });
});

test('an adapter/bus subscribe refused by the ACL degrades fan-out instead of crashing', async (t) => {
  const logs = captureConsoleError();
  resetRedisHealth();
  t.after(() => {
    logs.restore();
    resetRedisHealth();
  });

  const noperm = new Error('NOPERM No permissions to access a channel');
  let adapterSub: any = null;
  const stores = await createRedisPgStores({
    createClient: () => makeFailingClient(noperm),
    createAdapter: (_pub: unknown, sub: unknown) => {
      adapterSub = sub;
      return asSocketIoAdapter({ kind: 'fake-adapter' });
    },
  });
  t.after(() => stores.close());

  // The bus subscribe path (cache invalidations, call transitions) resolves
  // rather than rejecting, so nothing turns it into an unhandled rejection.
  await stores.messageBus.subscribe('signaling:call.transitions', () => {});

  // The adapter never awaits its own subscribe; the guard must swallow the
  // rejection on its behalf.
  stores.attachAdapter({ adapter: () => {} } as any);
  await assert.doesNotReject(() => Promise.resolve(adapterSub.pSubscribe('socket.io#/#', () => {})));
  await assert.doesNotReject(() => Promise.resolve(adapterSub.subscribe('socket.io#/#', () => {})));

  const health = getRedisHealth();
  assert.equal(health.degraded, true);
  assert.deepEqual(
    health.issues.map((issue) => issue.scope).sort(),
    ['fanout-adapter', 'message-bus']
  );
  assert.ok(
    logs.lines.some((line) => line.includes('fanout-adapter is DEGRADED') && line.includes('ACL SETUSER')),
    'the operator is told which subsystem died and how to fix it'
  );
});

test('a non-permission redis failure still rejects, preserving fail-closed startup', async (t) => {
  resetRedisHealth();
  t.after(() => resetRedisHealth());

  const unreachable = new Error('connect ECONNREFUSED 10.0.0.5:6379');
  let adapterSub: any = null;
  const stores = await createRedisPgStores({
    createClient: () => makeFailingClient(unreachable),
    createAdapter: (_pub: unknown, sub: unknown) => {
      adapterSub = sub;
      return asSocketIoAdapter({});
    },
  });
  t.after(() => stores.close());

  stores.attachAdapter({ adapter: () => {} } as any);
  await assert.rejects(
    () => Promise.resolve(adapterSub.subscribe('socket.io#/#', () => {})),
    /ECONNREFUSED/
  );
  await assert.rejects(
    () => stores.messageBus.subscribe('signaling:call.transitions', () => {}),
    /ECONNREFUSED/
  );
  assert.deepEqual(getRedisHealth(), { degraded: false, issues: [] });
});

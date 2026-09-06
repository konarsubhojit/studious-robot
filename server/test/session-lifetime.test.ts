import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStores } from '../src/stores/index.ts';
import { pruneExpiredSessions } from '../src/lib/state.ts';
import { createRedisPgStores } from '../src/stores/redis.ts';
import { SHARED_SESSION_MAX_TTL_MS } from '../src/config.ts';
import type { SessionRecord } from '../src/stores/contracts.ts';

function seed(
  stores: ReturnType<typeof createMemoryStores>,
  sessionId: string,
  userId: string,
  expiresAt: string | null
): void {
  const session: SessionRecord = {
    sessionId,
    userId,
    deviceId: `device-${sessionId}`,
    platform: null,
    createdAt: new Date(0).toISOString(),
    expiresAt,
  };
  stores.sessions.set(sessionId, session);
  const owned = stores.userSessions.get(userId) ?? new Set<string>();
  owned.add(sessionId);
  stores.userSessions.set(userId, owned);
}

test('the sweep drops expired sessions and leaves live ones alone', () => {
  const stores = createMemoryStores();
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  seed(stores, 'expired', 'alice', new Date(now - 1).toISOString());
  seed(stores, 'live', 'alice', new Date(now + 60_000).toISOString());

  assert.equal(pruneExpiredSessions(stores, { now }), 1);
  assert.equal(stores.sessions.has('expired'), false);
  assert.equal(stores.sessions.has('live'), true);
  assert.deepEqual([...(stores.userSessions.get('alice') ?? [])], ['live']);
});

// A session expiring exactly now is expired: `getSessionFromRequest` rejects on
// `< Date.now()`, so keeping it would leave an unusable row in the map.
test('the sweep treats an expiry of exactly now as expired', () => {
  const stores = createMemoryStores();
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  seed(stores, 'boundary', 'alice', new Date(now).toISOString());

  assert.equal(pruneExpiredSessions(stores, { now }), 1);
  assert.equal(stores.sessions.size, 0);
});

// `userSessions` is iterated by presence, so an emptied Set must not survive as
// a key — otherwise the sweep trades one leak for another.
test('the sweep removes a user index entry once its last session goes', () => {
  const stores = createMemoryStores();
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  seed(stores, 'only', 'alice', new Date(now - 1).toISOString());

  pruneExpiredSessions(stores, { now });
  assert.equal(stores.userSessions.has('alice'), false);
});

// `SESSION_TTL_MS=0` still produces immortal sessions on purpose; the sweep
// must not silently delete them.
test('the sweep never touches a session with no declared expiry', () => {
  const stores = createMemoryStores();
  seed(stores, 'immortal', 'alice', null);

  assert.equal(pruneExpiredSessions(stores, { now: Date.now() }), 0);
  assert.equal(stores.sessions.has('immortal'), true);
});

// A malformed `expiresAt` must not be read as "expired at NaN" (which would
// evict a session the request path still accepts) nor crash the sweep.
test('the sweep ignores an unparseable expiry rather than guessing', () => {
  const stores = createMemoryStores();
  seed(stores, 'garbled', 'alice', 'not-a-date');

  assert.equal(pruneExpiredSessions(stores, { now: Date.now() }), 0);
  assert.equal(stores.sessions.has('garbled'), true);
});

// ─── Shared (Redis) session keys ─────────────────────────────────────────────

type SetCall = { key: string; options?: { PX?: number } };

async function captureSessionWrites(session: SessionRecord): Promise<SetCall[]> {
  const sets: SetCall[] = [];
  const client = () => ({
    connect: async () => {},
    quit: async () => {},
    duplicate() {
      return client();
    },
    on() {},
    set: async (key: string, _value: string, options?: { PX?: number }) => {
      sets.push({ key, options });
      return 'OK';
    },
    get: async () => null,
    del: async () => 0,
    subscribe: async () => {},
    unsubscribe: async () => {},
    publish: async () => 0,
  });

  const stores = await createRedisPgStores({
    createClient: client as never,
    createAdapter: (() => (() => {})) as never,
  });
  try {
    await stores.sessionState?.save(session);
  } finally {
    await stores.close?.();
  }
  return sets;
}

function sessionExpiring(expiresAt: string | null): SessionRecord {
  return {
    sessionId: 'session-1',
    userId: 'alice',
    deviceId: 'device-1',
    platform: null,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
}

// Redis has no "expire eventually" mode: a key written without `PX` outlives
// the process that created it. Writing every session key with an expiry keeps
// the keyspace bounded by construction rather than by a sweep a crash can skip.
test('a shared session key is written with its own TTL', async () => {
  const ttlMs = 60 * 60 * 1000;
  const sets = await captureSessionWrites(
    sessionExpiring(new Date(Date.now() + ttlMs).toISOString())
  );

  assert.equal(sets.length, 1);
  assert.match(sets[0].key, /session-1$/);
  const px = sets[0].options?.PX ?? 0;
  assert.ok(px > ttlMs - 5_000 && px <= ttlMs, `expected ~${ttlMs}ms, got ${px}ms`);
});

test('a shared session key with no declared expiry still gets a bounded TTL', async () => {
  const sets = await captureSessionWrites(sessionExpiring(null));

  assert.equal(sets.length, 1);
  assert.equal(sets[0].options?.PX, SHARED_SESSION_MAX_TTL_MS);
});

// A session that is already expired must not be written without `PX` (Redis
// rejects a non-positive PX), so the TTL is clamped to the smallest it accepts.
test('an already-expired shared session key is clamped, never written unbounded', async () => {
  const sets = await captureSessionWrites(
    sessionExpiring(new Date(Date.now() - 60_000).toISOString())
  );

  assert.equal(sets.length, 1);
  assert.equal(sets[0].options?.PX, 1);
});

// A very long declared expiry must not defeat the bound either.
test('a shared session TTL is capped at the shared-store maximum', async () => {
  const sets = await captureSessionWrites(
    sessionExpiring(new Date(Date.now() + SHARED_SESSION_MAX_TTL_MS * 10).toISOString())
  );

  assert.equal(sets.length, 1);
  assert.equal(sets[0].options?.PX, SHARED_SESSION_MAX_TTL_MS);
});

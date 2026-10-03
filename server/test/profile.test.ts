/**
 * Profile read/write (`GET /profile`, `PATCH /profile`), the display-name
 * validation that guards the directory against impersonation, and the cache
 * invalidation a rename has to publish so a peer on another instance never
 * renders the old name for a full TTL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/index.ts';
import { CACHE_INVALIDATE_CHANNEL, conversationsCachePrefix } from '../src/cache.ts';
import { createMemoryMessageBus } from '../src/messageBus.ts';
import { createMemoryMessageStore } from '../src/messageStore.ts';
import {
  MAX_DISPLAY_NAME_LENGTH,
  impersonatesKnownUserId,
  normaliseDisplayName,
} from '../src/lib/displayName.ts';
import { asMessageStore, closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer(opts = {}) {
  const server = createServer({ messageStore: createMemoryMessageStore(), ...opts });
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/**
 * PATCH a JSON body, authenticating with the `Authorization` bearer header.
 */
async function patchJson(
  url: string,
  path: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { authorization: 'Bearer ' + sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// ─── Validation unit tests ───────────────────────────────────────────────────

test('normaliseDisplayName strips control characters and bidi overrides', () => {
  const result = normaliseDisplayName('Al\u0007ice\u202E\u200b Smith');
  assert.deepEqual(result, { ok: true, displayName: 'Alice Smith' });
});

test('normaliseDisplayName composes to NFC and collapses whitespace', () => {
  const result = normaliseDisplayName('  A\u0301lice\t\tB  ');
  assert.deepEqual(result, { ok: true, displayName: '\u00C1lice B' });
});

test('normaliseDisplayName rejects empty, non-string and over-long names', () => {
  assert.deepEqual(normaliseDisplayName('   \u202E '), { ok: false, reason: 'empty' });
  assert.deepEqual(normaliseDisplayName(42), { ok: false, reason: 'invalid_type' });
  assert.deepEqual(normaliseDisplayName(undefined), { ok: false, reason: 'invalid_type' });
  assert.deepEqual(normaliseDisplayName('a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)), {
    ok: false,
    reason: 'too_long',
  });
  // Emoji cost one codepoint, not two UTF-16 units.
  assert.equal(normaliseDisplayName('\u{1F642}'.repeat(MAX_DISPLAY_NAME_LENGTH)).ok, true);
});

test('normaliseDisplayName accepts null as "clear my display name"', () => {
  assert.deepEqual(normaliseDisplayName(null), { ok: true, displayName: null });
});

test('impersonatesKnownUserId folds case, spacing and punctuation', () => {
  const userIds = ['alice', 'bob'];
  assert.equal(impersonatesKnownUserId('B o b.', 'alice', userIds), true);
  assert.equal(impersonatesKnownUserId('BOB', 'alice', userIds), true);
  assert.equal(impersonatesKnownUserId('Bobby', 'alice', userIds), false);
  // Your own username impersonates nobody.
  assert.equal(impersonatesKnownUserId('Alice', 'alice', userIds), false);
});

// ─── Endpoints ───────────────────────────────────────────────────────────────

test('GET /profile requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  assert.equal((await getJson(url, '/profile')).status, 401);
  assert.equal((await patchJson(url, '/profile', { displayName: 'x' })).status, 401);
});

test('GET /profile returns the caller\'s own profile', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'alice');
  const res = await getJson(url, '/profile', session);
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, 'alice');
  assert.equal(res.body.displayName, null);
  assert.equal(res.body.avatarKey, null);
});

test('PATCH /profile updates the display name and clears it with null', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'alice');

  const updated = await patchJson(url, '/profile', { displayName: '  Alice\u202E A.  ' }, session);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.displayName, 'Alice A.');

  assert.equal((await getJson(url, '/profile', session)).body.displayName, 'Alice A.');

  const cleared = await patchJson(url, '/profile', { displayName: null }, session);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.displayName, null);
});

test('PATCH /profile requires a displayName field', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'alice');
  const res = await patchJson(url, '/profile', {}, session);
  assert.equal(res.status, 400);
});

test('display names are mutable, non-unique labels, not addressable identities', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);
  const aliceSession = await createSession(url, 'alice');
  const bobSession = await createSession(url, 'bob');

  for (const session of [aliceSession, bobSession]) {
    const res = await patchJson(url, '/profile', {
      displayName: 'Study Buddy',
      userId: 'renamed',
      authUid: 'different-account',
    }, session);
    assert.equal(res.status, 200);
  }
  assert.equal((await getJson(url, '/profile', aliceSession)).body.userId, 'alice');
  assert.equal((await getJson(url, '/profile', bobSession)).body.userId, 'bob');
  const searched = await getJson(url, '/users?search=Study%20Buddy', aliceSession);
  assert.deepEqual(searched.body.users.map((user: { userId: string; }) => user.userId), ['bob']);
  const byLabel = await getJson(url, '/users?userId=Study%20Buddy', aliceSession);
  assert.deepEqual(byLabel.body.users, []);
  const renamed = await patchJson(url, '/profile', { displayName: 'New Label' }, aliceSession);
  assert.equal(renamed.body.userId, 'alice');
  assert.equal(renamed.body.displayName, 'New Label');
});

test('PATCH /profile rejects a display name that matches another username', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'alice');
  await createSession(url, 'bob');

  const res = await patchJson(url, '/profile', { displayName: 'B O B' }, aliceSession);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'impersonates_user');
  assert.equal((await getJson(url, '/profile', aliceSession)).body.displayName, null);
});

test('PATCH /profile audits accepted and rejected changes', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'alice');
  await createSession(url, 'bob');

  assert.equal((await patchJson(url, '/profile', { displayName: 'Alice' }, session)).status, 200);
  assert.equal((await patchJson(url, '/profile', { displayName: 'bob' }, session)).status, 400);

  const audit = await getJson(url, '/audit-log', session);
  assert.equal(audit.status, 200);
  const events = audit.body.entries.map((entry: { event: string; }) => entry.event);
  assert.ok(events.includes('profile.display_name_changed'));
  assert.ok(events.includes('profile.display_name_rejected'));
});

test('PATCH /profile is rate limited', async (t) => {
  const { url, teardown } = await startServer({
    profileUpdateRateLimit: 2,
    profileUpdateRateWindowMs: 60_000,
  });
  t.after(teardown);

  const session = await createSession(url, 'alice');
  assert.equal((await patchJson(url, '/profile', { displayName: 'One' }, session)).status, 200);
  assert.equal((await patchJson(url, '/profile', { displayName: 'Two' }, session)).status, 200);

  const limited = await patchJson(url, '/profile', { displayName: 'Three' }, session);
  assert.equal(limited.status, 429);
  assert.ok(limited.body.retryAfter >= 1);
  assert.equal((await getJson(url, '/profile', session)).body.displayName, 'Two');
});

// ─── Directory projection ────────────────────────────────────────────────────

test('GET /users carries the profile fields and searches display names', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'alice');
  const bobSession = await createSession(url, 'bob');
  assert.equal((await patchJson(url, '/profile', { displayName: 'Robert' }, bobSession)).status, 200);

  const listed = await getJson(url, '/users', aliceSession);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.users, [
    {
      userId: 'bob',
      displayName: 'Robert',
      avatarKey: null,
      status: listed.body.users[0].status,
      online: listed.body.users[0].online,
      lastSeen: listed.body.users[0].lastSeen,
    },
  ]);

  const searched = await getJson(url, '/users?search=rober', aliceSession);
  assert.deepEqual(searched.body.users.map((user: { userId: string; }) => user.userId), ['bob']);
});

// ─── Cache invalidation ──────────────────────────────────────────────────────

test('PATCH /profile publishes a conversation-cache invalidation for every peer', async (t) => {
  const messageBus = createMemoryMessageBus();
  t.after(() => messageBus.close());

  const published: string[][] = [];
  const unsubscribe = await messageBus.subscribe(CACHE_INVALIDATE_CHANNEL, (message) => {
    published.push((message as { prefixes: string[]; }).prefixes);
  });
  t.after(() => unsubscribe());

  const inner = createMemoryMessageStore();
  const messageStore = asMessageStore({
    ...inner,
    async listConversations() {
      return [{ conversationId: 'alice|bob', peerId: 'bob', lastMessage: null, unreadCount: 0 }];
    },
  });

  const { url, teardown } = await startServer({ messageBus, messageStore });
  t.after(teardown);

  const session = await createSession(url, 'alice');
  assert.equal((await patchJson(url, '/profile', { displayName: 'Alice' }, session)).status, 200);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const prefixes = published.flat();
  assert.ok(prefixes.includes(conversationsCachePrefix('alice')));
  assert.ok(prefixes.includes(conversationsCachePrefix('bob')));
});

test('PATCH /profile publishes nothing when the name is unchanged', async (t) => {
  const messageBus = createMemoryMessageBus();
  t.after(() => messageBus.close());

  const published: string[][] = [];
  const unsubscribe = await messageBus.subscribe(CACHE_INVALIDATE_CHANNEL, (message) => {
    published.push((message as { prefixes: string[]; }).prefixes);
  });
  t.after(() => unsubscribe());

  const { url, teardown } = await startServer({ messageBus });
  t.after(teardown);

  const session = await createSession(url, 'alice');
  assert.equal((await patchJson(url, '/profile', { displayName: 'Alice' }, session)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = published.length;

  assert.equal((await patchJson(url, '/profile', { displayName: ' Alice ' }, session)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(published.length, before);
});

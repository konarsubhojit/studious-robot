/**
 * Avatars: the key namespace that is deliberately not `chatblobs/`, the
 * presigned upload bound to a narrow image allowlist, the directory-visibility
 * rule that replaces the conversation-scope rule chat media uses, and the
 * object lifecycle (a replacement deletes what it replaced).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_DOWNLOAD_TTL_SECONDS,
  avatarKeyOwner,
  createAvatarKey,
  deleteAvatarObject,
  isAvatarKeyOwnedBy,
  presignAvatarDownload,
} from '../src/avatars.ts';
import { loadR2Config } from '../src/attachments.ts';
import { createServer } from '../src/index.ts';
import * as schema from '../db/schema.ts';
import { asDatabase, closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

const R2_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_BUCKET: 'wetalk-media',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
};

/** Apply the R2 configuration for the duration of one test. */
function withR2Env(t: import('node:test').TestContext) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(R2_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Record the signed requests the server makes to object storage, so a test can
 * assert that a replaced object was really deleted.
 */
function captureStorageRequests(t: import('node:test').TestContext) {
  const original = globalThis.fetch;
  const requests: { method: string; url: string; }[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.includes(R2_ENV.R2_BUCKET)) {
      requests.push({ method: String(init?.method ?? 'GET'), url });
      return new Response(null, { status: 204 });
    }
    return original(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

async function startServer() {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  return { ...server, url, teardown: () => closeTestServer(server) };
}

/**
 * @returns the created session id
 */
async function createSession(url: string, userId: string): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/** Send a JSON body with an arbitrary method, authenticated as `sessionId`. */
async function sendJson(
  url: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { authorization: `Bearer ${sessionId}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Presign and publish an avatar for `userId`, returning its key. */
async function uploadAvatar(url: string, sessionId: string): Promise<string> {
  const presigned = await postJson(
    url,
    '/avatar/presign',
    { mimeType: 'image/png', sizeBytes: 4096 },
    sessionId
  );
  assert.equal(presigned.status, 200);
  const published = await sendJson(url, 'PUT', '/avatar', { key: presigned.body.key }, sessionId);
  assert.equal(published.status, 200);
  return presigned.body.key;
}

// ─── Key namespace ───────────────────────────────────────────────────────────

test('an avatar key is namespaced away from chat media and names its owner', () => {
  const key = createAvatarKey({ userId: 'alice', mimeType: 'image/webp' });
  assert.match(key, /^avatars\/alice\/[0-9a-f-]{36}\.webp$/);
  assert.equal(avatarKeyOwner(key), 'alice');
  assert.equal(isAvatarKeyOwnedBy(key, 'alice'), true);
  assert.equal(isAvatarKeyOwnedBy(key, 'bob'), false);
});

test('the owner segment survives a username that could otherwise forge a key', () => {
  // A username is a free-form string, so `/` and `..` have to be neutralised
  // without two different users ever colliding on one owner segment.
  for (const userId of ['a/b', '../admin', 'bob%2Fcarol', 'ünï cøde']) {
    const key = createAvatarKey({ userId, mimeType: 'image/png' });
    assert.equal(key.split('/').length, 3, key);
    assert.equal(avatarKeyOwner(key), userId);
  }
});

test('only a key this server could have minted resolves to an owner', () => {
  for (const key of [
    // Chat media: a different namespace, authorised by a different rule.
    'chatblobs/alice_bob/00000000-0000-4000-8000-000000000000.jpg',
    'avatars/alice/../../etc/passwd',
    'avatars/alice/photo.jpg',
    'avatars/alice/00000000-0000-4000-8000-000000000000.gif',
    'avatars//00000000-0000-4000-8000-000000000000.jpg',
    'avatars/alice/sub/00000000-0000-4000-8000-000000000000.jpg',
    'avatars/%zz/00000000-0000-4000-8000-000000000000.jpg',
    'https://bucket.example/avatars/alice/00000000-0000-4000-8000-000000000000.jpg',
    '',
    null,
  ]) {
    assert.equal(avatarKeyOwner(key), null, String(key));
  }
});

// ─── Presigned upload ────────────────────────────────────────────────────────

test('avatar presign refuses an unauthenticated caller', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/avatar/presign', { mimeType: 'image/png', sizeBytes: 1024 });
  assert.equal(res.status, 401);
});

test('avatar presign binds the size and the image MIME type to the signature', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'avatar-alice');
  const res = await postJson(
    url,
    '/avatar/presign',
    { mimeType: 'image/jpeg', sizeBytes: 2048 },
    session
  );

  assert.equal(res.status, 200);
  assert.match(res.body.key, /^avatars\/avatar-alice\/[0-9a-f-]{36}\.jpg$/);
  const uploadUrl = new URL(res.body.uploadUrl);
  assert.equal(uploadUrl.host, 'test-account.r2.cloudflarestorage.com');
  assert.equal(uploadUrl.pathname, `/${R2_ENV.R2_BUCKET}/${res.body.key}`);
  assert.equal(
    uploadUrl.searchParams.get('X-Amz-SignedHeaders'),
    'cache-control;content-length;content-type;host'
  );
  assert.ok(uploadUrl.searchParams.get('X-Amz-Signature'));
  assert.deepEqual(res.body.headers, {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': 'image/jpeg',
    'Content-Length': '2048',
  });
});

test('avatar presign keeps a narrow image allowlist and a real size cap', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'avatar-alice');
  for (const mimeType of ['image/gif', 'image/heic', 'application/pdf', 'text/plain', '']) {
    const res = await postJson(url, '/avatar/presign', { mimeType, sizeBytes: 1024 }, session);
    assert.equal(res.status, 400, mimeType);
  }
  const tooLarge = await postJson(
    url,
    '/avatar/presign',
    { mimeType: 'image/png', sizeBytes: 2 * 1024 * 1024 + 1 },
    session
  );
  assert.equal(tooLarge.status, 400);
  assert.match(tooLarge.body.error, /sizeBytes must be at most 2097152/);
});

// ─── Publication ─────────────────────────────────────────────────────────────

test('publishing refuses a key that is not the caller’s own avatar key', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'avatar-alice');
  const bobSession = await createSession(url, 'avatar-bob');
  const bobKey = await uploadAvatar(url, bobSession);

  for (const key of [
    bobKey,
    'chatblobs/avatar-alice_avatar-bob/00000000-0000-4000-8000-000000000000.jpg',
    'avatars/avatar-alice/../avatar-bob/00000000-0000-4000-8000-000000000000.jpg',
    '',
  ]) {
    const res = await sendJson(url, 'PUT', '/avatar', { key }, session);
    assert.equal(res.status, 400, key);
  }
});

test('replacing an avatar deletes the object it replaced', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);
  const storageRequests = captureStorageRequests(t);

  const session = await createSession(url, 'avatar-alice');
  const firstKey = await uploadAvatar(url, session);
  assert.equal(storageRequests.length, 0, 'the first upload replaces nothing');

  const secondKey = await uploadAvatar(url, session);
  assert.notEqual(secondKey, firstKey);
  // Exactly one signed DELETE, for the object that is no longer current. The
  // bucket carries no lifecycle rule, so nothing else would collect it.
  assert.equal(storageRequests.length, 1);
  assert.equal(storageRequests[0].method, 'DELETE');
  assert.equal(new URL(storageRequests[0].url).pathname, `/${R2_ENV.R2_BUCKET}/${firstKey}`);

  // Removing the avatar deletes the current object and clears the reference.
  const removed = await sendJson(url, 'DELETE', '/avatar', {}, session);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.avatarKey, null);
  assert.equal(storageRequests.length, 2);
  assert.equal(new URL(storageRequests[1].url).pathname, `/${R2_ENV.R2_BUCKET}/${secondKey}`);

  const gone = await getJson(url, '/avatar/download', session);
  assert.equal(gone.status, 404);
});

// ─── Download authorisation ──────────────────────────────────────────────────

test('an avatar is readable by anyone who can see its owner in the directory', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'avatar-alice');
  const bobSession = await createSession(url, 'avatar-bob');
  const key = await uploadAvatar(url, aliceSession);

  // The directory publishes the key — the stable cache identity of the bytes,
  // not a link to them.
  const directory = await getJson(url, '/users', bobSession);
  assert.equal(directory.status, 200);
  assert.equal(
    directory.body.users.find((u: { userId: string; }) => u.userId === 'avatar-alice').avatarKey,
    key
  );

  const res = await getJson(url, '/avatar/download?userId=avatar-alice', bobSession);
  assert.equal(res.status, 200);
  assert.equal(res.body.avatarKey, key);
  const downloadUrl = new URL(res.body.downloadUrl);
  assert.equal(downloadUrl.pathname, `/${R2_ENV.R2_BUCKET}/${key}`);
  assert.ok(downloadUrl.searchParams.get('X-Amz-Signature'));
  // Longer-lived than an attachment link because avatars are re-rendered
  // constantly, and far less sensitive when one leaks.
  assert.equal(
    downloadUrl.searchParams.get('X-Amz-Expires'),
    String(AVATAR_DOWNLOAD_TTL_SECONDS)
  );
});

test('a blocked user cannot fetch the avatar of someone they can no longer see', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'avatar-alice');
  const bobSession = await createSession(url, 'avatar-bob');
  await uploadAvatar(url, aliceSession);
  await uploadAvatar(url, bobSession);

  assert.equal(
    (await postJson(url, '/blocks', { blockeeId: 'avatar-bob' }, aliceSession)).status,
    200
  );

  // Both directions: the blocker stops seeing the blocked user's picture, and
  // the blocked user stops seeing the blocker's — exactly as `GET /users`
  // already hides them from each other.
  assert.equal(
    (await getJson(url, '/avatar/download?userId=avatar-alice', bobSession)).status,
    403
  );
  assert.equal(
    (await getJson(url, '/avatar/download?userId=avatar-bob', aliceSession)).status,
    403
  );
  // A block never hides you from yourself.
  assert.equal((await getJson(url, '/avatar/download', aliceSession)).status, 200);
});

test('an avatar download never takes the key from the caller', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'avatar-alice');
  const bobSession = await createSession(url, 'avatar-bob');
  const aliceKey = await uploadAvatar(url, aliceSession);

  // A supplied key is simply not part of the request: the owner's stored key
  // is what gets signed, so there is nothing to guess or replay.
  const res = await getJson(
    url,
    `/avatar/download?userId=avatar-alice&key=${encodeURIComponent('avatars/avatar-bob/x.png')}`,
    bobSession
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.avatarKey, aliceKey);

  const unknown = await getJson(url, '/avatar/download?userId=nobody', bobSession);
  assert.equal(unknown.status, 403);
  const noAvatar = await getJson(url, '/avatar/download?userId=avatar-bob', aliceSession);
  assert.equal(noAvatar.status, 404);
});

test('avatar deletion refuses a key outside the avatar namespace', async () => {
  const config = loadR2Config(R2_ENV);
  let requests = 0;
  const removed = await deleteAvatarObject({
    config,
    key: 'chatblobs/alice_bob/00000000-0000-4000-8000-000000000000.jpg',
    fetchImpl: async () => {
      requests += 1;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(removed, false);
  assert.equal(requests, 0);
});

// ─── Degradation ─────────────────────────────────────────────────────────────

test('avatars degrade to 503 when R2 is unconfigured, and nothing else breaks', async (t) => {
  for (const name of Object.keys(R2_ENV)) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous !== undefined) process.env[name] = previous;
    });
  }

  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'avatar-alice');
  assert.equal(
    (await postJson(url, '/avatar/presign', { mimeType: 'image/png', sizeBytes: 1024 }, session))
      .status,
    503
  );
  assert.equal((await getJson(url, '/avatar/download', session)).status, 503);
  // The directory still answers; the client falls back to initials.
  const directory = await getJson(url, '/users', session);
  assert.equal(directory.status, 200);
});

test('a presigned avatar download expires an hour after it is minted', () => {
  const config = loadR2Config(R2_ENV);
  const now = new Date('2026-09-23T09:22:15.000Z');
  const { expiresAt } = presignAvatarDownload({
    config,
    key: 'avatars/alice/00000000-0000-4000-8000-000000000000.png',
    now,
  });
  assert.equal(AVATAR_DOWNLOAD_TTL_SECONDS, 3600);
  assert.equal(Date.parse(expiresAt), now.getTime() + AVATAR_DOWNLOAD_TTL_SECONDS * 1000);
});

// ─── Multi-instance consistency ──────────────────────────────────────────────

test('a download signs the durably stored key, not this instance\u2019s copy', async (t) => {
  withR2Env(t);
  // `state.users` is per instance, so an avatar replaced on the other
  // signaling VM would otherwise be served here as the key it replaced — a key
  // whose object that VM has already deleted.
  const durableKey = 'avatars/avatar-alice/11111111-1111-4111-8111-111111111111.png';
  const updates: { set: any; }[] = [];
  const db = asDatabase({
    select() {
      return {
        from(table: any) {
          const rows = table === schema.users ? [{ avatarKey: durableKey }] : [];
          const chain: any = {
            where: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
          };
          return chain;
        },
      };
    },
    insert() {
      return { values: () => ({ onConflictDoUpdate: () => Promise.resolve(), onConflictDoNothing: () => Promise.resolve() }) };
    },
    update() {
      const entry: { set: any; } = { set: null };
      updates.push(entry);
      return {
        set(values: any) {
          entry.set = values;
          return { where: () => Promise.resolve() };
        },
      };
    },
    delete() {
      return { where: () => Promise.resolve() };
    },
  });

  const server = createServer({ db });
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  t.after(() => closeTestServer(server));
  const storageRequests = captureStorageRequests(t);

  const session = await createSession(url, 'avatar-alice');
  const presigned = await postJson(
    url,
    '/avatar/presign',
    { mimeType: 'image/png', sizeBytes: 1024 },
    session
  );
  assert.equal(presigned.status, 200);
  assert.equal(
    (await sendJson(url, 'PUT', '/avatar', { key: presigned.body.key }, session)).status,
    200
  );

  // The durable row is what the replacement is measured against, so the object
  // actually deleted is the one Postgres says was current.
  assert.equal(updates.at(-1)?.set.avatarKey, presigned.body.key);
  assert.equal(storageRequests.length, 1);
  assert.equal(new URL(storageRequests[0].url).pathname, `/${R2_ENV.R2_BUCKET}/${durableKey}`);

  const download = await getJson(url, '/avatar/download', session);
  assert.equal(download.status, 200);
  assert.equal(download.body.avatarKey, durableKey);
});

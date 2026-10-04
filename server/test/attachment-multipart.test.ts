import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { attachmentUploadOperation, queuedAttachmentKey, ATTACHMENT_PART_BYTES } from '../src/attachmentMultipart.ts';
import { loadR2Config, presignObjectRequest } from '../src/attachments.ts';
import { createAttachmentsRouter } from '../src/routes/attachments.routes.ts';
import type { ServerState } from '../src/stores/contracts.ts';

const env = {
  R2_ACCOUNT_ID: 'test-account', R2_BUCKET: 'private',
  R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
};
const config = loadR2Config(env)!;
const sizeBytes = ATTACHMENT_PART_BYTES + 123;
const mimeType = 'application/pdf';
const key = queuedAttachmentKey('alice:bob', 'alice', 'client-1', mimeType, sizeBytes);

function storage() {
  const ids = new Set<string>();
  const uploadKeys = new Map<string, string>();
  let stored = false;
  const discarded = new Map<string, NonNullable<RequestInit['headers']>>();
  let completedParts = '';
  let completeError = false;
  let initiate: (() => Promise<void>) | undefined;
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  const multipart = async (method: string, url: URL) => {
    const xml = (body: string, status = 200) => new Response(body, { status });
    if (url.searchParams.has('uploads')) {
      if (method === 'POST') {
        await initiate?.();
        ids.add('upload-1');
        uploadKeys.set('upload-1', decodeURIComponent(url.pathname.replace(/^\/private\//, '')));
        return xml('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
      }
      return xml(`<ListMultipartUploadsResult>${[...ids].map(id =>
        `<Upload><Key>${uploadKeys.get(id) ?? key}</Key><UploadId>${id}</UploadId></Upload>`).join('')}</ListMultipartUploadsResult>`);
    }
    const id = url.searchParams.get('uploadId');
    const objectKey = decodeURIComponent(url.pathname.replace(/^\/private\//, ''));
    if (id && (!ids.has(id) || (uploadKeys.get(id) ?? key) !== objectKey)) return xml('', 404);
    if (method === 'DELETE') { ids.delete(id!); return new Response(null, { status: 204 }); }
    if (method === 'GET') return xml(`<ListPartsResult>${completedParts}</ListPartsResult>`);
    if (completeError) return xml('<Error><Code>InvalidPart</Code></Error>');
    ids.delete(id!); stored = true;
    return xml('<CompleteMultipartUploadResult/>');
  };
  const fetchImpl: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const method = options?.method ?? 'GET';
    calls.push({ method, url, body: options?.body });
    assert.ok(url.searchParams.get('X-Amz-Signature'));
    assert.equal(url.host, 'test-account.r2.cloudflarestorage.com');
    const xml = (body: string, status = 200) => new Response(body, { status });
    if (url.pathname.endsWith('.discarded')) {
      if (method === 'PUT') { discarded.set(url.pathname, options?.headers ?? {}); return xml(''); }
      return new Response(null, { status: discarded.has(url.pathname) ? 200 : 404, headers: discarded.get(url.pathname) });
    }
    if (method === 'HEAD') return new Response(null, { status: stored ? 200 : 404, headers: { 'Content-Length': String(sizeBytes) } });
    if (url.searchParams.has('uploads') || url.searchParams.has('uploadId')) return multipart(method, url);
    if (method === 'DELETE') { stored = false; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected storage request ${method} ${url.pathname}`);
  };
  return {
    ids, calls, fetchImpl,
    setParts(parts: { partNumber: number; sizeBytes: number; etag: string }[]) {
      completedParts = parts.map(part =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><Size>${part.sizeBytes}</Size><ETag>${part.etag}</ETag></Part>`).join('');
    },
    setCompleteError() { completeError = true; },
    setInitiate(handler: () => Promise<void>) { initiate = handler; },
    get stored() { return stored; }, get discarded() { return discarded.size > 0; },
  };
}

test('queued identity binds actor, scope, descriptor and client id, not caller keys', () => {
  assert.equal(queuedAttachmentKey('alice:bob', 'alice', 'client-1', mimeType, sizeBytes), key);
  for (const other of [
    queuedAttachmentKey('alice:bob', 'bob', 'client-1', mimeType, sizeBytes),
    queuedAttachmentKey('alice:carol', 'alice', 'client-1', mimeType, sizeBytes),
    queuedAttachmentKey('alice:bob', 'alice', 'client-2', mimeType, sizeBytes),
    queuedAttachmentKey('alice:bob', 'alice', 'client-1', mimeType, sizeBytes + 1),
  ]) assert.notEqual(other, key);
  assert.ok(key.startsWith('chatblobs/alice_bob/'));
  assert.throws(() => queuedAttachmentKey('../escape', 'alice', 'client-1', mimeType, sizeBytes), /scope/);
});

test('multipart query values participate in the known SigV4 signature with S3 encoding', () => {
  const result = presignObjectRequest({
    config: { ...config, ttlSeconds: 300 }, method: 'PUT', key: 'chatblobs/alice_bob/test.pdf',
    queryValues: { uploadId: 'upload/+?=', partNumber: '2' }, signedHeaderValues: { 'content-length': '123' },
    now: new Date('2026-09-08T09:22:15.000Z'),
  });
  const url = new URL(result.url);
  assert.equal(url.searchParams.get('uploadId'), 'upload/+?=');
  assert.equal(url.searchParams.get('X-Amz-Signature'), '666a812fcc2de2b39cae289bce9c0dc48319459de2cfb9c495d4bab8d43fda00');
});

test('small queued uploads use private caching and an exact-length single-PUT grant', async () => {
  const r2 = storage();
  const result = await attachmentUploadOperation({ config, key, mimeType, sizeBytes: 123, action: 'prepare', fetchImpl: r2.fetchImpl });
  assert.equal(result.reference, key);
  assert.equal(result.headers?.['Cache-Control'], 'private, max-age=31536000, immutable');
  assert.equal(result.headers?.['Content-Length'], '123');
  assert.equal(result.headers?.['Content-Type'], mimeType);
  assert.equal(r2.ids.size, 0);
  assert.ok(new URL(result.uploadUrl!).searchParams.get('X-Amz-Signature'));
});

test('prepare recovers initiation and completed parts after a lost response or restart', async () => {
  const r2 = storage();
  const args = { config, key, mimeType, sizeBytes, fetchImpl: r2.fetchImpl };
  const first = await attachmentUploadOperation({ ...args, action: 'prepare' });
  assert.equal(first.uploadId, 'upload-1');
  r2.setParts([{ partNumber: 1, sizeBytes: ATTACHMENT_PART_BYTES, etag: '&quot;first&quot;' }]);
  const recovered = await attachmentUploadOperation({ ...args, action: 'prepare' });
  assert.equal(recovered.uploadId, first.uploadId);
  assert.deepEqual(recovered.parts, [{ partNumber: 1, sizeBytes: ATTACHMENT_PART_BYTES, etag: '"first"' }]);
  assert.equal(r2.calls.filter(call => call.method === 'POST' && call.url.searchParams.has('uploads')).length, 1);
});

test('part grants sign upload id, exact part number, and bounded byte count', async () => {
  const r2 = storage();
  r2.ids.add('upload-1');
  const args = { config, key, mimeType, sizeBytes, fetchImpl: r2.fetchImpl, uploadId: 'upload-1' };
  const result = await attachmentUploadOperation({ ...args, action: 'part', partNumber: 2 });
  const grant = new URL(result.uploadUrl!);
  assert.equal(grant.searchParams.get('uploadId'), 'upload-1');
  assert.equal(grant.searchParams.get('partNumber'), '2');
  assert.equal(grant.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
  assert.deepEqual(result.headers, { 'Content-Length': '123' });
  await assert.rejects(attachmentUploadOperation({ ...args, action: 'part', partNumber: 3 }), /part number/);
  await assert.rejects(attachmentUploadOperation({ ...args, action: 'part', partNumber: 1, uploadId: 'other-user' }), /Unknown/);
});

test('completion verifies authoritative part sizes, escapes ETags, and recovers a lost ack', async () => {
  const r2 = storage();
  r2.ids.add('upload-1');
  const args = { config, key, mimeType, sizeBytes, fetchImpl: r2.fetchImpl, uploadId: 'upload-1' };
  r2.setParts([{ partNumber: 1, sizeBytes: ATTACHMENT_PART_BYTES, etag: '&quot;first&quot;' }]);
  await assert.rejects(attachmentUploadOperation({ ...args, action: 'complete' }), /incomplete/);
  r2.setParts([
    { partNumber: 1, sizeBytes: ATTACHMENT_PART_BYTES, etag: '&quot;first&quot;' },
    { partNumber: 2, sizeBytes: 123, etag: '&quot;last&amp;tag&quot;' },
  ]);
  await attachmentUploadOperation({ ...args, action: 'complete' });
  assert.ok(r2.stored);
  assert.match(String(r2.calls.find(call => call.method === 'POST')?.body), /&quot;last&amp;tag&quot;/);
  const recovered = await attachmentUploadOperation({ ...args, action: 'prepare' });
  assert.equal(recovered.completed, true);
  assert.equal(recovered.reference, key);
});

test('an HTTP-200 embedded S3 completion error is not a completed upload', async () => {
  const r2 = storage();
  r2.ids.add('upload-1');
  r2.setParts([
    { partNumber: 1, sizeBytes: ATTACHMENT_PART_BYTES, etag: 'first' },
    { partNumber: 2, sizeBytes: 123, etag: 'last' },
  ]);
  r2.setCompleteError();
  await assert.rejects(attachmentUploadOperation({
    config, key, mimeType, sizeBytes, uploadId: 'upload-1', action: 'complete', fetchImpl: r2.fetchImpl,
  }), /failed to complete/);
});

test('discard fence deadline is durable, does not extend on retry, and server time gates final cleanup', async t => {
  const r2 = storage();
  const args = { config, key, mimeType, sizeBytes, fetchImpl: r2.fetchImpl, action: 'abort' };
  const first = await attachmentUploadOperation(args);
  assert.equal(first.cleanupComplete, false);
  assert.ok(first.retryAfterMs! > 0);
  const retry = await attachmentUploadOperation(args);
  assert.equal(retry.cleanupAfter, first.cleanupAfter);
  assert.equal(r2.calls.filter(call => call.method === 'PUT' && call.url.pathname.endsWith('.discarded')).length, 1);
  t.mock.method(Date, 'now', () => first.cleanupAfter! + 1);
  const final = await attachmentUploadOperation(args);
  assert.equal(final.cleanupComplete, true);
  assert.equal(final.retryAfterMs, 0);
});

test('final cleanup re-aborts a checkpoint upload ID even when listing no longer includes it', async () => {
  const r2 = storage();
  await attachmentUploadOperation({
    config, key, mimeType, sizeBytes, fetchImpl: r2.fetchImpl, action: 'abort', uploadId: 'already-aborted',
  });
  assert.ok(r2.calls.some(call => call.method === 'DELETE' && call.url.searchParams.get('uploadId') === 'already-aborted'));
});

test('discard aborts all multipart sessions, deletes bytes, and fences late initiation across restart', async () => {
  const r2 = storage();
  r2.ids.add('old-upload');
  let started!: () => void;
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  r2.setInitiate(async () => {
    started();
    await new Promise<void>(resolve => { finish = resolve; });
  });
  // Recover existing upload first, then simulate a separate late initiation.
  const args = { config, key, mimeType, sizeBytes, fetchImpl: r2.fetchImpl };
  await attachmentUploadOperation({ ...args, action: 'abort' });
  assert.equal(r2.ids.size, 0);
  assert.ok(r2.discarded);
  await assert.rejects(attachmentUploadOperation({ ...args, action: 'prepare' }), /discarded/);

  const fresh = storage();
  fresh.setInitiate(async () => {
    started();
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const late = attachmentUploadOperation({ ...args, action: 'prepare', fetchImpl: fresh.fetchImpl });
  await waiting;
  await attachmentUploadOperation({ ...args, action: 'abort', fetchImpl: fresh.fetchImpl });
  finish();
  await assert.rejects(late, /discarded/);
  assert.equal(fresh.ids.size, 0);
  assert.equal(fresh.stored, false);
  await attachmentUploadOperation({ ...args, action: 'abort', fetchImpl: fresh.fetchImpl });
});

test('upload endpoints authenticate, isolate uploader ids and permit cleanup after blocking', async t => {
  const r2 = storage();
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) =>
    String(input).startsWith(config.endpoint) ? r2.fetchImpl(input, options) : originalFetch(input, options));
  let blocked = false;
  let activeMember = true;
  let uploadAllowed = true;
  let sendChecks = 0;
  const state = {
    sessions: new Map([
      ['alice-session', { userId: 'alice' }], ['bob-session', { userId: 'bob' }],
    ]),
    blockState: { isBlocked: async () => blocked },
    conversationStore: { getMember: async (_groupId: string, actor: string) =>
      actor === 'alice' && activeMember ? { leftAt: null, removedAt: null, role: 'member' } : null },
    messageSendRateLimiter: { check: async () => { sendChecks++; return { allowed: true }; } },
    attachmentUploadRateLimiter: { check: async () => ({ allowed: uploadAllowed, resetAt: Date.now() + 60_000 }) },
    auditLog: { record: () => {} },
  } as unknown as ServerState;
  const app = express();
  app.use(express.json());
  app.use(createAttachmentsRouter({ state, env }));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const post = (body: object) => originalFetch(`http://127.0.0.1:${address.port}/attachments/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const body = { action: 'prepare', clientId: 'client-1', peerId: 'bob', type: 'file', mimeType, sizeBytes };
  assert.equal((await post(body)).status, 401);
  const alice = await post({ ...body, sessionId: 'alice-session' });
  assert.equal(alice.status, 200);
  const upload = await alice.json() as { key: string; uploadId: string };
  assert.equal(upload.key, key);
  const stolen = await post({
    ...body, action: 'part', sessionId: 'bob-session', peerId: 'alice',
    uploadId: upload.uploadId, partNumber: 1, key: upload.key,
  });
  assert.equal(stolen.status, 503);
  const foreignAbort = await post({
    ...body, action: 'abort', sessionId: 'bob-session', peerId: 'alice', uploadId: upload.uploadId,
  });
  assert.equal(foreignAbort.status, 200);
  assert.equal(r2.ids.size, 1);
  assert.equal((await post({ ...body, sessionId: 'alice-session', clientId: '../escape' })).status, 400);
  assert.equal((await post({ ...body, sessionId: 'alice-session', peerId: '../escape' })).status, 400);
  blocked = true;
  assert.equal((await post({ ...body, sessionId: 'alice-session' })).status, 403);
  const cleanup = await post({ ...body, action: 'abort', sessionId: 'alice-session' });
  assert.equal(cleanup.status, 200);
  assert.equal(r2.ids.size, 0);
  assert.equal(r2.stored, false);
  const group = { ...body, peerId: undefined, groupId: 'group-1', sessionId: 'alice-session' };
  assert.equal((await post(group)).status, 200);
  assert.equal((await post({ ...group, sessionId: 'bob-session' })).status, 403);
  activeMember = false;
  assert.equal((await post(group)).status, 403);
  assert.equal((await post({ ...group, action: 'abort' })).status, 200);
  assert.equal(r2.ids.size, 0);
  assert.equal(sendChecks, 0, 'upload controls must not consume the message-send budget');
  uploadAllowed = false;
  const throttled = await post({ ...group, action: 'abort' });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('Retry-After'), '60');
  assert.equal((await throttled.json() as { retryAfter: number }).retryAfter, 60);
});

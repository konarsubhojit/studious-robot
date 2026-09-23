/**
 * Attachment storage configuration: the private-bucket presign path, the
 * shape of a stored reference, and the startup diagnostics that name the
 * variable at fault when storage is misconfigured.
 *
 * The authorization rules themselves (session, block, scope) live in
 * `messages-rich.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOWNLOAD_PRESIGN_TTL_SECONDS,
  attachmentKeyFromReference,
  attachmentReferenceHost,
  describeR2Misconfiguration,
  isManagedAttachmentReference,
  loadR2Config,
  presignAttachmentDownload,
  presignAttachmentUpload,
} from '../src/attachments.ts';

const PRIVATE_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_BUCKET: 'wetalk-attachments-private',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
};

const KEY = 'chatblobs/alice_bob/00000000-0000-4000-8000-000000000000.zip';

function privateConfig(overrides: Record<string, string | undefined> = {}) {
  const config = loadR2Config({ ...PRIVATE_ENV, ...overrides });
  assert.ok(config);
  return config;
}

test('R2 configures without a public base URL', () => {
  const config = privateConfig();
  assert.equal(config.bucket, PRIVATE_ENV.R2_BUCKET);
  assert.equal(config.endpoint, 'https://test-account.r2.cloudflarestorage.com');
  // Nothing in the configuration describes a public origin any more.
  assert.ok(!('publicBaseUrl' in config));
});

test('an upload presigns into the private bucket and stores an opaque reference', () => {
  const presigned = presignAttachmentUpload({
    config: privateConfig(),
    key: KEY,
    mimeType: 'application/zip',
    sizeBytes: 19120588,
    now: new Date('2026-09-23T09:22:15.000Z'),
  });

  // The client stores the key itself: no scheme, no host, nothing fetchable.
  assert.equal(presigned.reference, KEY);
  assert.equal(attachmentReferenceHost(presigned.reference), null);

  const uploadUrl = new URL(presigned.uploadUrl);
  assert.equal(uploadUrl.host, 'test-account.r2.cloudflarestorage.com');
  assert.equal(uploadUrl.pathname, `/${PRIVATE_ENV.R2_BUCKET}/${KEY}`);
  assert.ok(uploadUrl.searchParams.get('X-Amz-Signature'));
});

test('a download presigns a signed GET against the private bucket', () => {
  const { downloadUrl, expiresAt } = presignAttachmentDownload({
    config: privateConfig(),
    key: KEY,
    now: new Date('2026-09-23T09:22:15.000Z'),
  });

  const parsed = new URL(downloadUrl);
  assert.equal(parsed.host, 'test-account.r2.cloudflarestorage.com');
  assert.equal(parsed.pathname, `/${PRIVATE_ENV.R2_BUCKET}/${KEY}`);
  assert.ok(parsed.searchParams.get('X-Amz-Signature'));
  // Long enough for the largest accepted attachment on a slow mobile link,
  // short enough that a leaked link expires in minutes.
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), String(DOWNLOAD_PRESIGN_TTL_SECONDS));
  assert.equal(DOWNLOAD_PRESIGN_TTL_SECONDS, 900);
  assert.equal(
    Date.parse(expiresAt),
    Date.parse('2026-09-23T09:22:15.000Z') + DOWNLOAD_PRESIGN_TTL_SECONDS * 1000
  );
});

test('a reference resolves only when it is a well-formed key under the prefix', () => {
  const config = privateConfig();
  assert.equal(attachmentKeyFromReference(config, KEY), KEY);
  assert.equal(isManagedAttachmentReference(config, KEY), true);

  for (const reference of [
    // A leftover public URL from before the private bucket: not a key.
    `https://bb.kiyon.store/${KEY}`,
    'https://attacker.example/tracker.jpg',
    'elsewhere/alice_bob/photo.jpg',
    'chatblobs/../private/secret.jpg',
    'chatblobs/alice_bob',
    '',
    null,
  ]) {
    assert.equal(attachmentKeyFromReference(config, reference), null, String(reference));
    assert.equal(isManagedAttachmentReference(config, reference), false, String(reference));
  }
});

test('an unresolvable reference reports a reason and its host, never the reference', () => {
  const config = privateConfig();
  const seen: { reason: string; host: string | null; }[] = [];

  attachmentKeyFromReference(config, `https://bb.kiyon.store/${KEY}?token=secret`, {
    onUnresolved: (details) => seen.push(details),
  });
  attachmentKeyFromReference(config, 'elsewhere/alice_bob/photo.jpg', {
    onUnresolved: (details) => seen.push(details),
  });

  assert.deepEqual(seen, [
    { reason: 'reference is not under chatblobs/', host: 'bb.kiyon.store' },
    { reason: 'reference is not under chatblobs/', host: null },
  ]);
});

test('startup diagnostics name the variable at fault', () => {
  // Nothing configured: a text-only deployment, and not a misconfiguration.
  assert.deepEqual(describeR2Misconfiguration({}), []);
  assert.deepEqual(describeR2Misconfiguration(PRIVATE_ENV), []);

  const halfConfigured = describeR2Misconfiguration({ R2_BUCKET: 'chat' });
  assert.equal(halfConfigured.length, 2);
  assert.match(halfConfigured[0], /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  assert.match(halfConfigured[1], /R2_ACCOUNT_ID/);

  const stillPublic = describeR2Misconfiguration({
    ...PRIVATE_ENV,
    R2_PUBLIC_BASE_URL: 'https://bb.kiyon.store',
  });
  assert.equal(stillPublic.length, 1);
  assert.match(stillPublic[0], /R2_PUBLIC_BASE_URL is set and ignored/);
  assert.match(stillPublic[0], /bucket-level/);
});

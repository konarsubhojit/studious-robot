/**
 * Attachment *resolution* tests: turning a stored attachment URL back into an
 * object key across base-URL generations, and presigning reads when a private
 * bucket has been introduced alongside the original public one.
 *
 * The authorization rules themselves (session, block, scope) live in
 * `messages-rich.test.ts`; what matters here is that widening resolution to
 * older hosts does not widen what may be resolved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachmentKeyFromUrl,
  attachmentUrlHost,
  loadR2Config,
  presignAttachmentDownload,
  publiclyReadableAttachmentVariable,
} from '../src/attachments.ts';
import { rewriteAttachmentHosts } from '../scripts/rewrite-attachment-hosts.ts';

const BASE_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_BUCKET: 'shared-assets',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_PUBLIC_BASE_URL: 'https://bb.kiyon.store',
};

/** The key shape both URL generations point at. */
const KEY = 'chatblobs/alice_bob/00000000-0000-4000-8000-000000000000.zip';

function configFor(overrides: Record<string, string | undefined> = {}) {
  const config = loadR2Config({ ...BASE_ENV, ...overrides });
  assert.ok(config);
  return config;
}

test('a URL stored under an earlier r2.dev base URL resolves to the same key', () => {
  const config = configFor();
  assert.equal(
    attachmentKeyFromUrl(config, `https://pub-63e944cb94da5108597.r2.dev/${KEY}`),
    KEY
  );
  // …as does one stored under the current custom domain.
  assert.equal(attachmentKeyFromUrl(config, `${config.publicBaseUrl}/${KEY}`), KEY);
});

test('a retired custom domain resolves once it is listed in R2_PUBLIC_BASE_URL_LEGACY', () => {
  const withoutLegacy = configFor();
  assert.equal(attachmentKeyFromUrl(withoutLegacy, `https://media.old.example/${KEY}`), null);

  const withLegacy = configFor({
    R2_PUBLIC_BASE_URL_LEGACY: 'https://media.old.example, https://cdn.older.example',
  });
  assert.equal(attachmentKeyFromUrl(withLegacy, `https://media.old.example/${KEY}`), KEY);
  assert.equal(attachmentKeyFromUrl(withLegacy, `https://cdn.older.example/${KEY}`), KEY);
});

test('an arbitrary host is refused however well-formed its key path looks', () => {
  const config = configFor();
  for (const url of [
    `https://attacker.example/${KEY}`,
    `https://bb.kiyon.store.attacker.example/${KEY}`,
    `file:///etc/${KEY}`,
  ]) {
    assert.equal(attachmentKeyFromUrl(config, url), null, url);
  }
});

test('a URL outside the chat-blob prefix, or escaping it, is refused', () => {
  const config = configFor();
  assert.equal(attachmentKeyFromUrl(config, `${BASE_ENV.R2_PUBLIC_BASE_URL}/elsewhere/alice_bob/x.zip`), null);
  assert.equal(
    attachmentKeyFromUrl(config, `${BASE_ENV.R2_PUBLIC_BASE_URL}/chatblobs/../private/secret.jpg`),
    null
  );
  // A prefix with no scope/file underneath is not a key either.
  assert.equal(attachmentKeyFromUrl(config, `${BASE_ENV.R2_PUBLIC_BASE_URL}/chatblobs/alice_bob`), null);
});

test('only the host of a stored URL is ever exposed for logging', () => {
  assert.equal(attachmentUrlHost(`https://bb.kiyon.store/${KEY}?X-Amz-Signature=secret`), 'bb.kiyon.store');
  assert.equal(attachmentUrlHost('not a url'), null);
});

test('a single-bucket deployment is flagged as publicly readable, a private-bucket one is not', () => {
  assert.equal(publiclyReadableAttachmentVariable(configFor()), 'R2_PUBLIC_BASE_URL');
  assert.equal(
    publiclyReadableAttachmentVariable(configFor({ R2_BUCKET_PRIVATE: 'chat-private' })),
    null
  );
});

test('download presigns against the private bucket without probing when it is the only one', async () => {
  const config = configFor({ R2_BUCKET_PRIVATE: 'shared-assets' });
  let probes = 0;
  const { downloadUrl } = await presignAttachmentDownload({
    config,
    key: KEY,
    fetchImpl: (async () => {
      probes += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(probes, 0);
  assert.equal(new URL(downloadUrl).pathname, `/shared-assets/${KEY}`);
});

test('download presigns against whichever bucket actually holds the object', async () => {
  const config = configFor({ R2_BUCKET_PRIVATE: 'chat-private' });
  const probed: string[] = [];
  /** Only the legacy public bucket still has this pre-switch object. */
  const fetchImpl = (async (url: string | URL, init?: { method?: string; }) => {
    const path = new URL(String(url)).pathname;
    probed.push(`${init?.method} ${path}`);
    return new Response(null, { status: path.startsWith('/shared-assets/') ? 200 : 404 });
  }) as unknown as typeof fetch;

  const legacy = await presignAttachmentDownload({ config, key: KEY, fetchImpl });
  assert.deepEqual(probed, [`HEAD /chat-private/${KEY}`, `HEAD /shared-assets/${KEY}`]);
  assert.equal(new URL(legacy.downloadUrl).pathname, `/shared-assets/${KEY}`);
  assert.ok(new URL(legacy.downloadUrl).searchParams.get('X-Amz-Signature'));

  // A new upload lives in the private bucket and is found on the first probe.
  const privateOnly = await presignAttachmentDownload({
    config,
    key: KEY,
    fetchImpl: (async (url: string | URL) =>
      new Response(null, {
        status: new URL(String(url)).pathname.startsWith('/chat-private/') ? 200 : 404,
      })) as unknown as typeof fetch,
  });
  assert.equal(new URL(privateOnly.downloadUrl).pathname, `/chat-private/${KEY}`);
});

test('download still mints a link for the private bucket when neither probe answers', async () => {
  const config = configFor({ R2_BUCKET_PRIVATE: 'chat-private' });
  const { downloadUrl } = await presignAttachmentDownload({
    config,
    key: KEY,
    fetchImpl: (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
  });
  assert.equal(new URL(downloadUrl).pathname, `/chat-private/${KEY}`);
});

// ─── scripts/rewrite-attachment-hosts.ts ──────────────────────────────────────

/**
 * A pool double returning `rows` for the scan and recording every statement.
 */
function fakeRewritePool(rows: { message_id: string; url: string; }[]) {
  const statements: { sql: string; params?: unknown[]; }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: sql.includes('SELECT') ? rows : [] };
    },
    release() {},
  };
  return {
    statements,
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

test('the rewrite script reports without writing until --apply is passed', async () => {
  const config = configFor();
  const rows = [
    { message_id: 'm-legacy', url: `https://pub-63e944cb94da5108597.r2.dev/${KEY}` },
    { message_id: 'm-current', url: `${BASE_ENV.R2_PUBLIC_BASE_URL}/${KEY}` },
    { message_id: 'm-foreign', url: `https://attacker.example/${KEY}` },
  ];

  const dry = fakeRewritePool(rows);
  const dryRun = await rewriteAttachmentHosts(dry.pool, { config });
  assert.deepEqual(dryRun, {
    scanned: 3,
    rewritten: 1,
    alreadyCurrent: 1,
    unresolved: 1,
    applied: false,
  });
  assert.equal(dry.statements.at(-1)?.sql, 'ROLLBACK');
  assert.ok(!dry.statements.some((statement) => statement.sql.startsWith('UPDATE')));

  const applied = fakeRewritePool(rows);
  const applyRun = await rewriteAttachmentHosts(applied.pool, { config, apply: true });
  assert.equal(applyRun.rewritten, 1);
  assert.equal(applied.statements.at(-1)?.sql, 'COMMIT');
  const updates = applied.statements.filter((statement) => statement.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.params, ['m-legacy', `${BASE_ENV.R2_PUBLIC_BASE_URL}/${KEY}`]);
});

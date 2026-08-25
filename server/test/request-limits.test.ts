import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { listenOnRandomPort } from './helpers.ts';

/**
 * Request-size limits.
 *
 * `express.json()` defaults to a 100 KB body. Nothing this API accepts comes
 * close — the largest legitimate body is a chat send, capped by the shared
 * schema at 4000 characters, and attachment bytes never pass through the API at
 * all (they are PUT straight to object storage through a presigned URL). The
 * explicit limit keeps an unauthenticated caller from making the process buffer
 * and parse megabytes before the route ever runs.
 */
test('an oversized JSON body is rejected before it reaches a route', async () => {
  const { httpServer } = createServer();
  const port = await listenOnRandomPort(httpServer);

  try {
    const oversized = JSON.stringify({ userId: 'a'.repeat(200 * 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });

    assert.equal(res.status, 413);
  } finally {
    await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
  }
});

test('a normally-sized JSON body is still parsed', async () => {
  const { httpServer } = createServer();
  const port = await listenOnRandomPort(httpServer);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // The body parsed, so the route — not the parser — decided the outcome.
    assert.notEqual(res.status, 413);
    assert.ok(res.status >= 400 && res.status < 500, `expected a client error, got ${res.status}`);
  } finally {
    await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
  }
});

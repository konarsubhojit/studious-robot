/**
 * `createRateLimiter`'s bucket map is keyed by whatever identifier a caller
 * supplies (userId, sessionId, IP, ...). Without pruning, a stream of unique
 * keys — spoofed identities, rotating session ids, etc. — grows the map
 * forever even though each bucket's window has long since expired. These
 * tests pin down the time-bound sweep that keeps the map bounded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/security.ts';

test('createRateLimiter enforces the window before pruning kicks in', () => {
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000 });
  const now = 0;
  assert.equal(limiter.check('user-1', now).allowed, true);
  assert.equal(limiter.check('user-1', now).allowed, true);
  assert.equal(limiter.check('user-1', now).allowed, false);

  // Window rolls over: the same key is allowed again.
  assert.equal(limiter.check('user-1', now + 1000).allowed, true);
});

test('createRateLimiter sweeps expired buckets without further checks', async () => {
  const windowMs = 20;
  const limiter = createRateLimiter({ maxRequests: 5, windowMs });
  limiter.check('user-1');
  assert.equal(limiter.size(), 1);

  await new Promise(resolve => setTimeout(resolve, windowMs * 3));

  assert.equal(limiter.size(), 0);
});

test('createRateLimiter reset clears a single key or the whole map', () => {
  const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
  limiter.check('a', 0);
  limiter.check('b', 0);
  assert.equal(limiter.size(), 2);

  limiter.reset('a');
  assert.equal(limiter.size(), 1);

  limiter.reset();
  assert.equal(limiter.size(), 0);
});

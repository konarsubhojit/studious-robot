/**
 * `createRateLimiter`'s bucket map is keyed by whatever identifier a caller
 * supplies (userId, sessionId, IP, ...). Without pruning, a stream of unique
 * keys — spoofed identities, rotating session ids, etc. — grows the map
 * forever even though each bucket's window has long since expired. These
 * tests pin down the opportunistic sweep that keeps the map bounded.
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

test('createRateLimiter sweeps expired buckets so unique keys do not accumulate forever', () => {
  const maxRequests = 5;
  const windowMs = 1000;
  const limiter = createRateLimiter({ maxRequests, windowMs }) as ReturnType<typeof createRateLimiter> & { size: () => number; };

  // Feed far more unique keys than the sweep interval while keeping every
  // call's window already expired relative to `now`. Each `check()` starts a
  // fresh bucket at `now` for its own key, but the *previous* keys' buckets
  // (windowStart = 0) are now stale relative to the growing `now`.
  const totalKeys = 500;
  for (let i = 0; i < totalKeys; i += 1) {
    // Advance `now` well past the window on every call so older buckets are
    // always expired by the time the sweep runs.
    const now = i * (windowMs + 1);
    limiter.check(`key-${i}`, now);
  }

  // The map must not have grown to `totalKeys` entries: periodic sweeping
  // should have dropped the now-expired buckets from earlier iterations.
  assert.ok(
    limiter.size() < totalKeys,
    `expected pruning to keep the bucket map below ${totalKeys}, got ${limiter.size()}`
  );
});

test('createRateLimiter reset clears a single key or the whole map', () => {
  const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 }) as ReturnType<typeof createRateLimiter> & { size: () => number; };
  limiter.check('a', 0);
  limiter.check('b', 0);
  assert.equal(limiter.size(), 2);

  limiter.reset('a');
  assert.equal(limiter.size(), 1);

  limiter.reset();
  assert.equal(limiter.size(), 0);
});

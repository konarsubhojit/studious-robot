import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countRoomRecipients,
  resetRecipientLookupRateLimit,
  RECIPIENT_LOOKUP_TIMEOUT_MS,
} from '../src/signaling/callHandlers.ts';

/**
 * Unit coverage for the recipient-counting diagnostic on the `rtc.offer` /
 * `rtc.answer` relay path.
 *
 * The relay itself must never be gated on this count (see the doc comment on
 * `countRoomRecipients`), so these tests only exercise the counting function
 * in isolation, standing in for the parts of `io` it touches.
 */

/** Build a minimal `io`-shaped double whose `fetchSockets()` behaves as given. */
function fakeIo(fetchSockets: () => Promise<unknown>) {
  return {
    in: () => ({ fetchSockets }),
  };
}

test('countRoomRecipients returns the count on a fast, successful lookup', async () => {
  const io = fakeIo(async () => [{ id: 'a' }, { id: 'b' }]);
  const count = await countRoomRecipients(io, 'user-1', 'rtc.offer');
  assert.equal(count, 2);
});

test('countRoomRecipients returns null (not 0) when the lookup times out', async () => {
  resetRecipientLookupRateLimit();
  const io = fakeIo(
    () =>
      new Promise((resolve) => {
        // Never resolves within the race window; the test itself completes
        // well before the underlying timer would ever fire.
        setTimeout(() => resolve([{ id: 'a' }]), RECIPIENT_LOOKUP_TIMEOUT_MS * 10);
      })
  );
  const count = await countRoomRecipients(io, 'user-1', 'rtc.offer');
  assert.equal(count, null);
});

test('countRoomRecipients returns null when the adapter rejects', async () => {
  resetRecipientLookupRateLimit();
  const io = fakeIo(async () => {
    throw new Error('adapter unreachable');
  });
  const count = await countRoomRecipients(io, 'user-1', 'rtc.offer');
  assert.equal(count, null);
});

test('countRoomRecipients does not look for uncounted events', async () => {
  let called = false;
  const io = fakeIo(async () => {
    called = true;
    return [];
  });
  const count = await countRoomRecipients(io, 'user-1', 'rtc.candidate');
  assert.equal(count, null);
  assert.equal(called, false);
});

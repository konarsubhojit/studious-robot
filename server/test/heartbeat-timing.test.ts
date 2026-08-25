import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_HEARTBEAT_DUE_MS,
  CALL_HEARTBEAT_INTERVAL_MS,
  CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
} from '../../shared/index.ts';
import { CALL_HEARTBEAT_INTERVAL_MS as SERVER_INTERVAL_MS, DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS as SERVER_TIMEOUT_MS } from '../src/config.ts';

/**
 * The client heartbeat interval and the server heartbeat timeout are two halves
 * of one protocol contract. They were previously declared as independent
 * literals in `mobile/` and `server/`, kept in step only by a comment on each
 * side — if the client interval ever exceeded the server timeout, every healthy
 * call would be hung up on mid-conversation.
 *
 * These assertions are the enforcement that was missing.
 */
test('the server re-exports the shared heartbeat timing rather than its own copy', () => {
  assert.equal(SERVER_INTERVAL_MS, CALL_HEARTBEAT_INTERVAL_MS);
  assert.equal(SERVER_TIMEOUT_MS, DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS);
});

test('the heartbeat timeout allows several missed beats', () => {
  assert.equal(
    DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
    CALL_HEARTBEAT_INTERVAL_MS * CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE
  );
  // A single missed beat must never be enough to end a call.
  assert.ok(CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE >= 2);
  assert.ok(DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS > CALL_HEARTBEAT_INTERVAL_MS);
});

test('a beat becomes due slightly before the interval elapses', () => {
  // Otherwise a timer firing a few milliseconds early slips a whole period.
  assert.ok(CALL_HEARTBEAT_DUE_MS < CALL_HEARTBEAT_INTERVAL_MS);
  assert.ok(CALL_HEARTBEAT_DUE_MS > CALL_HEARTBEAT_INTERVAL_MS / 2);
});

test('the timing values are preserved from before they were centralised', () => {
  // Guards the move itself: centralising must not have changed behaviour.
  assert.equal(CALL_HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS, 150_000);
  assert.equal(CALL_HEARTBEAT_DUE_MS, 29_000);
});

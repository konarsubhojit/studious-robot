import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_HEARTBEAT_DUE_MS,
  CALL_HEARTBEAT_INTERVAL_MS,
  CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE,
  CALL_RECOVERY_BUDGET_MS,
  CALL_RECOVERY_MAX_EPISODE_MS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
  PARTICIPANT_DISCONNECT_DETECTION_ALLOWANCE_MS,
} from '../../shared/index.ts';
import {
  CALL_HEARTBEAT_INTERVAL_MS as SERVER_INTERVAL_MS,
  CALL_RECOVERY_BUDGET_MS as SERVER_RECOVERY_BUDGET_MS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS as SERVER_TIMEOUT_MS,
  DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS as SERVER_GRACE_MS,
  DEFAULT_SOCKET_PING_INTERVAL_MS,
  DEFAULT_SOCKET_PING_TIMEOUT_MS,
} from '../src/config.ts';

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

/**
 * The recovery ordering invariant.
 *
 * Three deadlines used to decide whether a call survived a Wi-Fi⇄cellular
 * handoff — a 12s client fuse, a 15s server grace and a ~17-20s socket ladder —
 * as three unrelated literals in three packages. Every one of them expired
 * before the 30s a handoff can take, and the client's own fuse *ended the call*
 * when it did.
 *
 * They are now derived from one shared budget, and this is what stops them
 * drifting apart again: the client must always be the one that decides a call
 * is dead, so its budget has to expire first and the server's bounds last.
 */
test('the client recovery budget expires before the server ends the call', () => {
  assert.ok(
    CALL_RECOVERY_BUDGET_MS < DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
    'client budget must be inside the server disconnect grace'
  );
  assert.ok(
    DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS < DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
    'server grace must be inside the heartbeat timeout'
  );
});

test('the disconnect grace covers the lag before a dead socket is even noticed', () => {
  // The server can take `pingInterval + pingTimeout` to declare a socket dead,
  // and only then does the grace timer start.
  const detectionLagMs = DEFAULT_SOCKET_PING_INTERVAL_MS + DEFAULT_SOCKET_PING_TIMEOUT_MS;
  assert.ok(PARTICIPANT_DISCONNECT_DETECTION_ALLOWANCE_MS >= detectionLagMs);
  assert.equal(
    DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
    CALL_RECOVERY_BUDGET_MS + PARTICIPANT_DISCONNECT_DETECTION_ALLOWANCE_MS
  );
});

test('the server re-exports the shared recovery timing rather than its own copy', () => {
  assert.equal(SERVER_RECOVERY_BUDGET_MS, CALL_RECOVERY_BUDGET_MS);
  assert.equal(SERVER_GRACE_MS, DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS);
  // The grace used to be a 15s literal declared in `server/src/config.ts`,
  // which is *inside* the window in which a client is still actively
  // recovering.
  assert.ok(SERVER_GRACE_MS > 15_000);
});

test('a flapping interface cannot extend an episode without bound', () => {
  assert.ok(CALL_RECOVERY_MAX_EPISODE_MS > CALL_RECOVERY_BUDGET_MS);
  assert.ok(CALL_RECOVERY_MAX_EPISODE_MS < DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS);
});

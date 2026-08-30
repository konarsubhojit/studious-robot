import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoomJoin, normaliseReportedActiveCallIds } from '../src/signaling/connection/state.ts';

test('decideRoomJoin ignores missing session and invalid room ids', () => {
  assert.deepEqual(
    decideRoomJoin({
      sessionId: null,
      roomId: 'room-1',
      currentRoom: null,
      roomSize: 0,
      maxRoomSize: 4,
    }),
    { action: 'ignore' }
  );
  assert.deepEqual(
    decideRoomJoin({
      sessionId: 'session-1',
      roomId: '',
      currentRoom: null,
      roomSize: 0,
      maxRoomSize: 4,
    }),
    { action: 'ignore' }
  );
});

test('decideRoomJoin enforces room capacity and returns prior room transition', () => {
  assert.deepEqual(
    decideRoomJoin({
      sessionId: 'session-1',
      roomId: 'room-1',
      currentRoom: 'room-old',
      roomSize: 4,
      maxRoomSize: 4,
    }),
    { action: 'room_full' }
  );
  assert.deepEqual(
    decideRoomJoin({
      sessionId: 'session-1',
      roomId: 'room-1',
      currentRoom: 'room-old',
      roomSize: 1,
      maxRoomSize: 4,
    }),
    { action: 'join', leaveRoomId: 'room-old' }
  );
});

test('normaliseReportedActiveCallIds preserves reconciliation semantics', () => {
  assert.deepEqual(
    normaliseReportedActiveCallIds({ activeCallIds: ['abc', ' ', null, 'def'] }),
    ['abc', 'def']
  );
  assert.deepEqual(
    normaliseReportedActiveCallIds({ callId: 'xyz' }),
    ['xyz']
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidRoomId, SIGNALING_EVENTS } = require('../src/protocol.js');

test('accepts URL-safe room ids', () => {
  for (const id of ['room-1', 'a', 'Room_2.test', 'A'.repeat(64)]) {
    assert.equal(isValidRoomId(id), true, `expected "${id}" to be valid`);
  }
});

test('rejects invalid room ids', () => {
  for (const id of ['', ' ', 'has space', 'bad/slash', 'a'.repeat(65), null, undefined, 42, {}]) {
    assert.equal(isValidRoomId(id), false, `expected ${JSON.stringify(id)} to be invalid`);
  }
});

test('exposes a frozen event contract', () => {
  assert.equal(SIGNALING_EVENTS.JOIN_ROOM, 'join-room');
  assert.equal(SIGNALING_EVENTS.OFFER, 'offer');
  assert.equal(SIGNALING_EVENTS.ANSWER, 'answer');
  assert.equal(SIGNALING_EVENTS.ICE_CANDIDATE, 'ice-candidate');
  assert.equal(SIGNALING_EVENTS.PEER_JOINED, 'peer-joined');
  assert.equal(SIGNALING_EVENTS.PEER_LEFT, 'peer-left');
  assert.equal(SIGNALING_EVENTS.ROOM_FULL, 'room-full');
  assert.equal(Object.isFrozen(SIGNALING_EVENTS), true);
});

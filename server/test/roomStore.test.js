'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomStore } = require('../src/roomStore.js');

test('add returns true until the room reaches capacity, then false', () => {
  const rooms = createRoomStore({ maxRoomSize: 2 });
  assert.equal(rooms.add('r', 'a'), true);
  assert.equal(rooms.add('r', 'b'), true);
  assert.equal(rooms.isFull('r'), true);
  assert.equal(rooms.add('r', 'c'), false);
  assert.equal(rooms.size('r'), 2);
});

test('remove deletes a member and reports presence', () => {
  const rooms = createRoomStore({ maxRoomSize: 2 });
  rooms.add('r', 'a');
  assert.equal(rooms.remove('r', 'a'), true);
  assert.equal(rooms.remove('r', 'a'), false);
  assert.equal(rooms.size('r'), 0);
});

test('a vacated slot can be reused', () => {
  const rooms = createRoomStore({ maxRoomSize: 2 });
  rooms.add('r', 'a');
  rooms.add('r', 'b');
  rooms.remove('r', 'a');
  assert.equal(rooms.isFull('r'), false);
  assert.equal(rooms.add('r', 'c'), true);
});

test('empty rooms are cleaned up and absent from the snapshot', () => {
  const rooms = createRoomStore({ maxRoomSize: 2 });
  rooms.add('r', 'a');
  rooms.remove('r', 'a');
  assert.deepEqual(rooms.snapshot(), { activeRooms: 0, activeParticipants: 0, maxRoomSize: 2 });
});

test('snapshot aggregates across multiple rooms', () => {
  const rooms = createRoomStore({ maxRoomSize: 2 });
  rooms.add('r1', 'a');
  rooms.add('r1', 'b');
  rooms.add('r2', 'c');
  assert.deepEqual(rooms.snapshot(), { activeRooms: 2, activeParticipants: 3, maxRoomSize: 2 });
});

test('configurable maxRoomSize allows larger rooms', () => {
  const rooms = createRoomStore({ maxRoomSize: 3 });
  assert.equal(rooms.add('r', 'a'), true);
  assert.equal(rooms.add('r', 'b'), true);
  assert.equal(rooms.add('r', 'c'), true);
  assert.equal(rooms.add('r', 'd'), false);
});

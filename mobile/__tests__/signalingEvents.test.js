import { SIGNALING_EVENTS } from '../src/signalingEvents';

describe('signalingEvents', () => {
  test('exposes the shared event contract matching the server', () => {
    expect(SIGNALING_EVENTS.JOIN_ROOM).toBe('join-room');
    expect(SIGNALING_EVENTS.OFFER).toBe('offer');
    expect(SIGNALING_EVENTS.ANSWER).toBe('answer');
    expect(SIGNALING_EVENTS.ICE_CANDIDATE).toBe('ice-candidate');
    expect(SIGNALING_EVENTS.PEER_JOINED).toBe('peer-joined');
    expect(SIGNALING_EVENTS.PEER_LEFT).toBe('peer-left');
    expect(SIGNALING_EVENTS.ROOM_FULL).toBe('room-full');
  });

  test('is frozen to prevent accidental mutation', () => {
    expect(Object.isFrozen(SIGNALING_EVENTS)).toBe(true);
  });
});

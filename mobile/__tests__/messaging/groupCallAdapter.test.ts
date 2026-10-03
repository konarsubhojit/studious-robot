import { CLIENT_EVENTS, parseEventPayload, SERVER_EVENTS } from '../../../shared';
import { groupCallAcknowledgement, groupCallRequest, parseGroupCallSnapshot, startMockGroupCall, transitionMockGroupCall } from '../../src/chat/groupCallAdapter';
import { createMockGroup } from '../../src/chat/groupMockAdapter';

const row = () => createMockGroup('alice', 'Team', ['bob', 'carol'], 'mock-group-1');
const now = '2026-10-03T06:00:00Z';
const start = () => startMockGroupCall(row(), 'alice', 'mock-call-1', 'audio', now);

test('all group call requests use exactly the frozen schema, never peer-call events', () => {
  expect(groupCallRequest('start', 'group-1', 'video')).toEqual({
    event: CLIENT_EVENTS.CONVERSATION_CALL_START,
    payload: { version: 2, conversationId: 'group-1', mediaType: 'video' },
  });
  for (const action of ['accept', 'decline', 'leave'] as const) {
    const request = groupCallRequest(action, 'call-1');
    expect(request.event).toBe(`conversation.call.${action}`);
    expect(request.payload).toEqual({ version: 2, callId: 'call-1' });
    expect(parseEventPayload(request.event, request.payload, 'client').success).toBe(true);
  }
  expect(() => groupCallRequest('start', '')).toThrow();
});

test('local snapshots carry every required call and participant field from the server schema', () => {
  const snapshot = start();
  expect(parseEventPayload(SERVER_EVENTS.CONVERSATION_CALL_UPDATED, snapshot, 'server').success).toBe(true);
  expect(snapshot.call).toMatchObject({
    callId: 'mock-call-1', conversationId: 'mock-group-1', initiatorId: 'alice',
    mediaType: 'audio', status: 'ringing', stateVersion: 1,
  });
  expect(snapshot.participants).toEqual([
    { callId: 'mock-call-1', userId: 'alice', status: 'accepted', invitedAt: now, acceptedAt: now, leftAt: null },
    { callId: 'mock-call-1', userId: 'bob', status: 'ringing', invitedAt: now, acceptedAt: null, leftAt: null },
    { callId: 'mock-call-1', userId: 'carol', status: 'ringing', invitedAt: now, acceptedAt: null, leftAt: null },
  ]);
  expect(snapshot.participants[0]).not.toHaveProperty('muted');
  expect(groupCallAcknowledgement({ ok: true, version: 2, call: snapshot.call, participants: snapshot.participants }))
    .toEqual(snapshot);
  expect(() => groupCallAcknowledgement({ ok: true })).toThrow();
});

test('mock accept/decline/leave preserve identity, timestamps, statuses and state versions', () => {
  const acceptedAt = '2026-10-03T06:01:00Z';
  const accepted = transitionMockGroupCall(start(), 'bob', 'accept', acceptedAt);
  expect(accepted.call).toMatchObject({ status: 'active', stateVersion: 2 });
  expect(accepted.participants[1]).toMatchObject({ status: 'accepted', acceptedAt });
  const declined = transitionMockGroupCall(accepted, 'carol', 'decline', now);
  expect(declined.participants[2].status).toBe('declined');
  const left = transitionMockGroupCall(declined, 'bob', 'leave', acceptedAt);
  expect(left.participants[1]).toMatchObject({ status: 'left', leftAt: acceptedAt });
  const ended = transitionMockGroupCall(left, 'alice', 'leave', acceptedAt);
  expect(ended.call).toMatchObject({ callId: 'mock-call-1', status: 'ended', stateVersion: 5 });
  expect(() => transitionMockGroupCall(ended, 'bob', 'accept', now)).toThrow('unavailable');
  expect(start().participants[1].status).toBe('ringing');
});

test('participant gates and inconsistent/malformed snapshots are rejected', () => {
  expect(() => startMockGroupCall(row(), 'eve', 'c', 'audio', now)).toThrow('member');
  expect(() => transitionMockGroupCall(start(), 'eve', 'accept', now)).toThrow('unavailable');
  expect(() => transitionMockGroupCall(start(), 'alice', 'accept', now)).toThrow('cannot');
  expect(() => parseGroupCallSnapshot({ ...start(), callId: 'wrong' })).toThrow('Inconsistent');
  expect(() => parseGroupCallSnapshot({ ...start(), participants: [{ ...start().participants[0], callId: 'wrong' }] }))
    .toThrow('Inconsistent');
  expect(() => parseGroupCallSnapshot({ ...start(), participants: [start().participants[0], start().participants[0]] }))
    .toThrow('Inconsistent');
  expect(() => parseGroupCallSnapshot({ ...start(), participants: [{ userId: 'alice', status: 'muted' }] })).toThrow();
});

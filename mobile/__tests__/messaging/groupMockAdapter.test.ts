import { CLIENT_EVENTS, parseEventPayload } from '../../../shared';
import {
  createMockGroup, leaveMockGroup, mutateMockMembers, renameMockGroup, sendMockGroup,
} from '../../src/chat/groupMockAdapter';
import { applyGroupSnapshot } from '../../src/chat/groupTransportAdapter';
import { buildOutboxItem, outboxSendPayload, restoreOutboxMessages } from '../../src/messaging/sendPipeline';
import { mergePendingConversations, totalUnread } from '../../src/messaging/conversations';

const group = () => createMockGroup('alice', ' Team ', ['bob', 'carol', 'bob', 'alice'], 'mock-group-1');
const queued = () => buildOutboxItem({
  messageId: 'm1', recipientId: 'mock-group-1', conversationId: 'mock-group-1',
  targetKind: 'group', localMock: true, createdAt: '2026-10-03T01:00:00Z', body: 'hello',
});

test('creation validates the frozen shape, deduplicates members and trims names', () => {
  expect(group().group).toEqual({
    conversationId: 'mock-group-1', name: 'Team', creatorId: 'alice',
    memberIds: ['alice', 'bob', 'carol'], membershipVersion: 1,
  });
  expect(() => createMockGroup('alice', 'Team', ['alice', 'bob'], 'g')).toThrow('at least two');
  expect(() => createMockGroup('alice', '', ['bob', 'carol'], 'g')).toThrow();
});

test('membership admin gates are enforced in the adapter, not just the UI', () => {
  expect(() => mutateMockMembers(group(), 'bob', { type: 'add', userIds: ['dave'] })).toThrow('admin');
  expect(() => mutateMockMembers(group(), 'alice', { type: 'remove', userId: 'alice' })).toThrow('admin');
  const added = mutateMockMembers(group(), 'alice', { type: 'add', userIds: ['dave', 'bob'] });
  expect(added.group?.memberIds).toEqual(['alice', 'bob', 'carol', 'dave']);
  expect(mutateMockMembers(added, 'alice', { type: 'remove', userId: 'bob' }).group?.memberIds)
    .toEqual(['alice', 'carol', 'dave']);
  expect(() => mutateMockMembers({ ...group(), localMock: false }, 'alice', { type: 'add', userIds: ['dave'] }))
    .toThrow('local preview');
});

test('rename/leave use contract validation and reject further actions after leaving', () => {
  expect(renameMockGroup(group(), 'alice', 'Renamed').group?.name).toBe('Renamed');
  expect(() => renameMockGroup(group(), 'bob', 'Renamed')).toThrow('admin');
  expect(() => renameMockGroup(group(), 'alice', '')).toThrow();
  const left = leaveMockGroup(group(), 'alice');
  expect(left.left).toBe(true);
  expect(left.group?.memberIds).not.toContain('alice');
  expect(() => sendMockGroup(left, queued(), 'alice')).toThrow('no longer');
  expect(() => mutateMockMembers(left, 'alice', { type: 'add', userIds: ['dave'] })).toThrow('admin');
});

test('outbox targets exactly conversationId XOR recipientId and retains identity through restoration', () => {
  const item = queued();
  const payload = outboxSendPayload(item);
  expect(payload).toMatchObject({ version: 2, conversationId: 'mock-group-1', messageId: 'm1' });
  expect(payload).not.toHaveProperty('recipientId');
  expect(payload).not.toHaveProperty('localMock');
  expect(parseEventPayload(CLIENT_EVENTS.MESSAGE_SEND, payload, 'client').success).toBe(true);
  const direct = outboxSendPayload({ ...item, targetKind: undefined, recipientId: 'bob', conversationId: 'alice:bob' });
  expect(direct).toHaveProperty('recipientId', 'bob');
  expect(direct).not.toHaveProperty('conversationId');
  expect(() => outboxSendPayload({ ...item, conversationId: null })).toThrow('Missing group');
  const restored = restoreOutboxMessages({}, [item], 'alice');
  expect(restored['mock-group-1'][0]).toMatchObject({ messageId: 'm1', pending: true });
  expect(restoreOutboxMessages(restored, [item], 'alice')['mock-group-1']).toHaveLength(1);
  expect(sendMockGroup(group(), item, 'alice')).toMatchObject({ messageId: 'm1', body: 'hello' });
});

test('mixed lists preserve mock groups, unread counts, and authoritative membership versions', () => {
  const local = { ...group(), unreadCount: 3 };
  const direct = { peerId: 'bob', unreadCount: 2 };
  const merged = mergePendingConversations([direct], [local], new Set());
  expect(merged).toEqual([local, direct]);
  expect(totalUnread(merged)).toBe(5);
  const snapshot = { ...local.group!, membershipVersion: 2, memberIds: ['bob', 'carol'] };
  const updated = applyGroupSnapshot(merged, snapshot, 'alice');
  expect(updated[0]).toMatchObject({ left: true, localMock: false, unreadCount: 0 });
  expect(updated[1]).toEqual(direct);
  expect(applyGroupSnapshot(updated, local.group!, 'alice')).toBe(updated);
});

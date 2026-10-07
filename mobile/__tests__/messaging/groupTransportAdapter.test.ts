import {
  conversationAcknowledgement, GROUP_TRANSPORT, parseGroupInvitations, parseGroupList, remoteGroupRows,
} from '../../src/chat/groupTransportAdapter';
import { createMockGroup } from '../../src/chat/groupMockAdapter';
import { mergePendingConversations } from '../../src/messaging/conversations';

const snapshot = () => createMockGroup('alice', 'Team', ['bob', 'carol'], 'server-group').group!;
const row = () => ({ ...createMockGroup('alice', 'Team', ['bob', 'carol'], 'server-group'), localMock: false, unreadCount: 3 });

test('transport is mock by default and validates actual server lifecycle acknowledgements', () => {
  expect(GROUP_TRANSPORT).toBe('mock');
  expect(conversationAcknowledgement({ ok: true, version: 2, conversation: snapshot() }, 'alice')).toEqual(snapshot());
  expect(() => conversationAcknowledgement({ ok: true }, 'alice')).toThrow();
  // An untrustworthy list is reported as absent, so the direct half of the same
  // response still applies and held group rows are not mistaken for departures.
  expect(parseGroupList([{ conversationId: 'missing-fields' }], 'alice')).toBeUndefined();
  expect(parseGroupList({ conversationId: 'not-a-list' }, 'alice')).toBeUndefined();
});

test('group invitations are accepted as a list only when addressed to the signed-in user', () => {
  const invitation = {
    invitationId: 'invitation-1', conversationId: 'server-group', issuerId: 'alice', inviteeId: 'bob',
    membershipVersion: 2, createdAt: '2026-10-03T06:00:00Z', expiresAt: '2026-10-10T06:00:00Z',
  };
  expect(parseGroupInvitations([invitation], 'bob')).toEqual([invitation]);
  expect(parseGroupInvitations([{ ...invitation, inviteeId: 'mallory' }], 'bob')).toBeUndefined();
  expect(parseGroupInvitations({ invitations: [invitation] }, 'bob')).toBeUndefined();
});

test('REST snapshots normalize without a peerId and preserve local message/read/unread metadata', () => {
  const held = { ...row(), readByMember: { bob: '2026-10-03T06:00:00Z' } };
  const records = parseGroupList([{ ...snapshot(), name: 'Renamed', membershipVersion: 2 }], 'alice');
  expect(remoteGroupRows(records, [held], 'alice', new Map([['server-group', 1]]))[0])
    .toMatchObject({ peerId: 'server-group', localMock: false, unreadCount: 3,
      group: { name: 'Renamed', membershipVersion: 2 }, readByMember: held.readByMember });
  expect(remoteGroupRows(undefined, [held], 'alice', new Map())).toEqual([held]);
});

test('missing remote groups mark departure but a snapshot created/updated during a fetch is not erased', () => {
  const held = row();
  expect(remoteGroupRows([], [held], 'alice', new Map([['server-group', 1]]))[0])
    .toMatchObject({ left: true, unreadCount: 0 });
  expect(remoteGroupRows([], [held], 'alice', new Map())).toEqual([held]);
  const newer = { ...held, group: { ...held.group!, membershipVersion: 2 } };
  expect(remoteGroupRows([], [newer], 'alice', new Map([['server-group', 1]]))).toEqual([newer]);
});

test('pending group messages cannot mask a server-authoritative membership removal', () => {
  const held = row();
  const updated = { ...held, left: true, group: { ...held.group!, memberIds: ['bob', 'carol'], membershipVersion: 2 } };
  const merged = mergePendingConversations([updated], [held], new Set(['server-group']));
  expect(merged[0]).toMatchObject({ left: true, unreadCount: 0, group: { membershipVersion: 2, memberIds: ['bob', 'carol'] } });
});

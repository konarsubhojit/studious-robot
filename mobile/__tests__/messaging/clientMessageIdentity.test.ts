import { CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION, parseEventPayload } from '../../../shared';
import { withReconciledMessage } from '../../src/messaging/conversations';
import { dedupeAndSort, mergeHistoryPage, patchMessage, upsertTimelineEntry } from '../../src/messaging/messageHistory';
import { timelineEntryId } from '../../src/messaging/messageIdentity';
import { applyDeliveryReceipt } from '../../src/messaging/receivePipeline';
import {
  asSent, buildOptimisticMessage, buildOutboxItem, outboxSendPayload,
  resolveOutboxReply, restoreOutboxMessages, withAttemptsReset,
  drainQueuedMessages, unavailableReplyReason, optimisticReplyKey, withResolvedReplies,
} from '../../src/messaging/sendPipeline';

const key = '7afae83c-6454-4da1-9c4d-231c204f411d';
const input = {
  messageId: key, clientMessageId: key, conversationId: 'alice:bob',
  senderId: 'alice', recipientId: 'bob', body: 'once', createdAt: '2026-10-03T10:00:00.000Z',
};
const optimistic = () => buildOptimisticMessage(input);
const confirmed = () => ({
  ...input, messageId: 'server-uuid', createdAt: '2026-10-03T10:00:01.000Z', deliveredTo: ['bob'],
});

test('versioned send, event and durable queue carry explicit key without smuggling messageId', () => {
  const item = buildOutboxItem(input);
  const payload = outboxSendPayload(item);
  expect(payload).toMatchObject({ clientMessageId: key, version: SIGNALING_VERSION });
  expect(payload).not.toHaveProperty('messageId');
  expect(parseEventPayload(CLIENT_EVENTS.MESSAGE_SEND, payload).success).toBe(true);
  expect(parseEventPayload(SERVER_EVENTS.MESSAGE_RECEIVED, { version: 2, message: confirmed() }).success).toBe(true);
  expect(outboxSendPayload(withAttemptsReset([item], key)[0])).toEqual(payload);
  expect(outboxSendPayload(JSON.parse(JSON.stringify(item)))).toEqual(payload);
  expect(outboxSendPayload({ ...item, targetKind: 'group' })).toMatchObject({
    conversationId: 'alice:bob', clientMessageId: key,
  });
  const legacy = { ...item };
  delete legacy.clientMessageId;
  expect(outboxSendPayload(legacy)).toHaveProperty('messageId', key);
});

test('ack reconciles provisional UUID, server timestamp and optimistic reply references', () => {
  const reply = buildOptimisticMessage({ ...input, messageId: 'reply-key', clientMessageId: 'reply-key', replyTo: key });
  const state = { bob: [optimistic(), reply] };
  const next = patchMessage(state, 'bob', key, entry => asSent(entry, confirmed()));
  expect(next.bob).toHaveLength(2);
  expect(next.bob.find(entry => entry.clientMessageId === key)).toMatchObject({
    messageId: 'server-uuid', clientMessageId: key, createdAt: confirmed().createdAt, pending: false, syncState: 'synced',
  });
  expect(next.bob.find(entry => entry.clientMessageId === 'reply-key')?.replyTo).toBe('server-uuid');
  expect(restoreOutboxMessages(next, [buildOutboxItem(input)], 'alice').bob).toHaveLength(2);
});

test('receipt before ack and late optimistic mirrors converge without losing receipts', () => {
  const received = applyDeliveryReceipt({ bob: [optimistic()] }, confirmed());
  expect(received.bob).toHaveLength(1);
  expect(received.bob[0]).toMatchObject({ messageId: 'server-uuid', pending: false, deliveredTo: ['bob'] });
  const replayed = patchMessage(received, 'bob', key, entry => asSent(entry, { ...confirmed(), deliveredTo: [] }), 'alice');
  expect(replayed.bob).toHaveLength(1);
  expect(replayed.bob[0].deliveredTo).toEqual(['bob']);
  expect(dedupeAndSort([replayed.bob[0], optimistic()])[0].messageId).toBe('server-uuid');
});

test('persisted server identity wins mixed merge order even without a local syncState', () => {
  const pending = { ...optimistic(), syncState: undefined };
  for (const entries of [[confirmed(), pending], [pending, confirmed()]]) {
    expect(dedupeAndSort(entries)).toHaveLength(1);
    expect(dedupeAndSort(entries)[0]).toMatchObject({
      messageId: 'server-uuid', clientMessageId: key, pending: false, syncState: 'synced',
    });
  }
});

test('first/older history pages and live upserts reconcile the same UUID and retain local compose time', () => {
  for (const before of [undefined, '2026-10-03T11:00:00.000Z']) {
    const history = mergeHistoryPage([optimistic()], [confirmed()], { before });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      messageId: 'server-uuid', clientCreatedAt: input.createdAt, syncState: 'synced', pending: false,
    });
  }
  expect(upsertTimelineEntry({ bob: [optimistic()] }, 'bob', confirmed()).bob).toHaveLength(1);
});

test('different senders sharing a key stay distinct in one timeline', () => {
  const other = { ...confirmed(), messageId: 'other-server', senderId: 'bob', recipientId: 'alice' };
  expect(timelineEntryId(other)).not.toBe(timelineEntryId(confirmed()));
  expect(dedupeAndSort([optimistic(), confirmed(), other])).toHaveLength(2);
  for (const local of [optimistic(), confirmed()]) {
    const reconciled = patchMessage({ bob: [local, other] }, 'bob', key, entry => asSent(entry, confirmed()), 'alice');
    expect(reconciled.bob).toHaveLength(2);
    expect(reconciled.bob.find(entry => entry.senderId === 'alice')?.messageId).toBe('server-uuid');
    expect(reconciled.bob.find(entry => entry.senderId === 'bob')).toMatchObject(other);
  }
});

test('sender-scoped ack also preserves a legacy peer server id equal to the provisional UUID', () => {
  const legacyPeer = { ...confirmed(), messageId: key, clientMessageId: undefined, senderId: 'bob', recipientId: 'alice' };
  const reconciled = patchMessage({ bob: [optimistic(), legacyPeer] }, 'bob', key, entry => asSent(entry, confirmed()), 'alice');
  expect(reconciled.bob).toHaveLength(2);
  expect(reconciled.bob.find(entry => entry.senderId === 'alice')?.messageId).toBe('server-uuid');
  expect(reconciled.bob.find(entry => entry.senderId === 'bob')).toMatchObject(legacyPeer);
});

test('queued reply waits for parent reconciliation, then persists a stable server reference', () => {
  const reply = buildOutboxItem({ ...input, messageId: 'reply-key', clientMessageId: 'reply-key', replyTo: key });
  expect(resolveOutboxReply(reply, [optimistic()], 'alice')).toBeNull();
  const other = { ...confirmed(), senderId: 'bob', messageId: 'other-server' };
  const resolved = resolveOutboxReply(reply, [other, confirmed()], 'alice')!;
  expect(resolved.replyTo).toBe('server-uuid');
  expect(resolveOutboxReply(resolved, [confirmed()], 'alice')).toBe(resolved);
  expect(outboxSendPayload(resolved)).toMatchObject({ replyTo: 'server-uuid', clientMessageId: 'reply-key' });
});

test('reply dependencies distinguish waiting, failed and missing parents without rejecting legacy server references', () => {
  const parent = optimistic();
  const reply = buildOutboxItem({
    ...input, messageId: 'reply-key', clientMessageId: 'reply-key', replyTo: key,
    replyToLocalMessageId: optimisticReplyKey(key, [parent], 'alice'),
  });
  expect(unavailableReplyReason(reply, [parent], [buildOutboxItem(input)], 'alice')).toBeNull();
  expect(unavailableReplyReason(reply, [{ ...parent, syncState: 'failed' }], [], 'alice')).toContain('failed');
  expect(resolveOutboxReply(reply, [], 'alice')).toBeNull();
  expect(unavailableReplyReason(reply, [], [], 'alice')).toContain('no longer available');
  const legacy = { messageId: 'legacy-reply', recipientId: 'bob', body: 'legacy', replyTo: 'unloaded-server-id' };
  expect(resolveOutboxReply(legacy, [], 'alice')).toBe(legacy);
  expect(outboxSendPayload(legacy)).toHaveProperty('messageId', 'legacy-reply');
  const resolved = withResolvedReplies([reply], key, 'server-parent')[0];
  expect(resolved).toMatchObject({ clientMessageId: 'reply-key', replyTo: 'server-parent' });
  expect(resolved.replyToLocalMessageId).toBeUndefined();
});

test('waiting replies pause only their conversation; permanently unavailable replies do not block sendable rows', async () => {
  const queue = ['reply', 'bob-1', 'carol-1', 'bob-2', 'carol-2'].map(body => ({
    messageId: body, recipientId: body.startsWith('carol') ? 'carol' : 'bob', body,
  }));
  const sent: string[] = [];
  expect(await drainQueuedMessages(queue, async item => {
    sent.push(item.body!);
    return item.body === 'reply' ? 'waiting' : true;
  })).toBe(false);
  expect(sent).toEqual(['reply', 'carol-1', 'carol-2']);
  sent.length = 0;
  expect(await drainQueuedMessages(queue, async item => {
    sent.push(item.body!);
    return item.body === 'reply' ? 'unavailable' : true;
  })).toBe(false);
  expect(sent).toEqual(['reply', 'bob-1', 'carol-1', 'bob-2', 'carol-2']);
});

test('ack updates its conversation preview but does not overwrite a newer optimistic send', () => {
  const conversation = { peerId: 'bob', lastMessage: optimistic(), unreadCount: 0 };
  expect(withReconciledMessage([conversation], 'bob', key, confirmed())[0].lastMessage?.messageId).toBe('server-uuid');
  const newer = { ...conversation, lastMessage: { ...optimistic(), messageId: 'new', clientMessageId: 'new' } };
  expect(withReconciledMessage([newer], 'bob', key, confirmed())[0]).toBe(newer);
});

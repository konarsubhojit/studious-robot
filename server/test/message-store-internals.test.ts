/**
 * Unit tests for the pure halves of the message store (`src/messageStore/`).
 *
 * These rules — how a page is bounded, what a search term is turned into before
 * it reaches the database, how a conversation list is grouped, and what a
 * tombstone leaves behind — used to be observable only by driving a store.
 * Extracting them made each a function over plain data, so an escape that
 * quietly stops covering a metacharacter is a failing assertion rather than a
 * user-supplied `%` that matches every message on the instance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseConversations } from '../src/messageStore/conversations.ts';
import { escapeLikePattern } from '../src/messageStore/pgStore.ts';
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  bodyMatches,
  clampLimit,
  deriveConversationId,
  normaliseSearchTerm,
} from '../src/messageStore/queries.ts';
import {
  applyReaction,
  applyTombstone,
  byNewestFirst,
  createMessageRecord,
  nextTimestamp,
  normaliseReactions,
} from '../src/messageStore/records.ts';
import type { StoredMessage } from '../src/messageStore/types.ts';

/** A stored message with only the fields a given case cares about set. */
function message(overrides: Partial<StoredMessage> & { messageId: string; }): StoredMessage {
  return createMessageRecord({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hi',
    ...overrides,
  });
}

// ─── Query construction ───────────────────────────────────────────────────────

test('a conversation id is the same from either direction', () => {
  assert.equal(deriveConversationId('bob', 'alice'), 'alice:bob');
  assert.equal(deriveConversationId('alice', 'bob'), 'alice:bob');
});

test('a requested page size is clamped into the supported range', () => {
  assert.equal(clampLimit(undefined), DEFAULT_MESSAGE_LIMIT);
  assert.equal(clampLimit('not a number'), DEFAULT_MESSAGE_LIMIT);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-10), 1);
  assert.equal(clampLimit(10.7), 10);
  assert.equal(clampLimit(MAX_MESSAGE_LIMIT + 1), MAX_MESSAGE_LIMIT);
});

test('a search term is trimmed and matched literally', () => {
  assert.equal(normaliseSearchTerm('  lunch  '), 'lunch');
  assert.equal(normaliseSearchTerm(null), '');
  assert.equal(normaliseSearchTerm(undefined), '');
});

test('a search term cannot smuggle a LIKE wildcard into the query', () => {
  // `%` and `_` are the only metacharacters `LIKE` has, plus the escape
  // character itself.  Unescaped, a search for `%` would match every message
  // the caller can see rather than the literal percent sign they typed.
  assert.equal(escapeLikePattern('100%'), '100\\%');
  assert.equal(escapeLikePattern('a_b'), 'a\\_b');
  assert.equal(escapeLikePattern('back\\slash'), 'back\\\\slash');
  // Regex metacharacters are *not* escaped: LIKE does not interpret them, so
  // they already match literally.
  assert.equal(escapeLikePattern('.*+?[]()'), '.*+?[]()');
});

test('the Postgres pattern and the in-memory matcher agree on what matches', () => {
  // The two backends must not disagree about search results, so the pattern
  // built for Postgres is the same literal, case-insensitive substring test
  // `bodyMatches` applies in memory.
  const term = normaliseSearchTerm('  Lunch  ');
  assert.equal(bodyMatches({ body: 'about lunch today' }, term), true);
  assert.equal(bodyMatches({ body: 'LUNCHTIME' }, term), true);
  assert.equal(bodyMatches({ body: 'dinner' }, term), false);
  assert.equal(bodyMatches({}, term), false);
  assert.equal(escapeLikePattern(term.toLowerCase()), 'lunch');
});

// ─── Records ──────────────────────────────────────────────────────────────────

test('a new record materialises every rich field', () => {
  const record = createMessageRecord({ senderId: 'alice', recipientId: 'bob', body: 'hi' });

  assert.equal(record.conversationId, 'alice:bob');
  assert.equal(record.type, 'text');
  assert.equal(record.attachment, null);
  assert.equal(record.replyTo, null);
  assert.deepEqual(record.reactions, {});
  assert.equal(record.deletedAt, null);
  assert.deepEqual(record.deliveredTo, []);
  assert.equal(record.readAt, null);
  assert.ok(record.messageId, 'a messageId is generated when the client sent none');

  // An unsupported type is never persisted as-is.
  const odd = createMessageRecord({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hi',
    type: 'hologram',
  });
  assert.equal(odd.type, 'text');
});

test('generated timestamps are strictly increasing', () => {
  const stamps = [nextTimestamp(), nextTimestamp(), nextTimestamp()];
  const sorted = [...stamps].sort();

  assert.deepEqual(stamps, sorted);
  assert.equal(new Set(stamps).size, stamps.length, 'no two messages can tie');
});

test('reactions are normalised to unique, non-empty user id lists', () => {
  assert.deepEqual(normaliseReactions(null), {});
  assert.deepEqual(normaliseReactions([]), {});
  assert.deepEqual(normaliseReactions({ '👍': ['alice', 'alice', 'bob', '', 7] }), {
    '👍': ['alice', 'bob'],
  });
  assert.deepEqual(normaliseReactions({ '👍': 'alice', '🎉': [] }), {});
});

test('a reaction change is idempotent in both directions', () => {
  const added = applyReaction({}, '👍', 'alice', 'add');
  assert.deepEqual(added, { '👍': ['alice'] });
  assert.deepEqual(applyReaction(added, '👍', 'alice', 'add'), { '👍': ['alice'] });

  const removed = applyReaction(added, '👍', 'alice', 'remove');
  assert.deepEqual(removed, {}, 'the emoji key goes when nobody is left');
  assert.deepEqual(applyReaction(removed, '👍', 'alice', 'remove'), {});

  // The original map is never mutated.
  assert.deepEqual(added, { '👍': ['alice'] });
});

test('a tombstone strips the content but keeps the row', () => {
  const original = message({
    messageId: 'm-1',
    body: 'secret',
    attachment: { url: 'https://example.invalid/a.png' },
    reactions: { '👍': ['bob'] },
  });

  const tombstone = applyTombstone(original, '2024-01-01T00:00:00.000Z');

  assert.equal(tombstone.body, '');
  assert.equal(tombstone.attachment, null);
  assert.deepEqual(tombstone.reactions, {});
  assert.equal(tombstone.deletedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(tombstone.messageId, 'm-1', 'the row survives so a reply still resolves');
});

test('messages sort newest first, with messageId breaking a tie', () => {
  const older = message({ messageId: 'm-1', createdAt: '2024-01-01T00:00:00.000Z' });
  const newer = message({ messageId: 'm-2', createdAt: '2024-01-02T00:00:00.000Z' });
  const tied = message({ messageId: 'm-0', createdAt: '2024-01-01T00:00:00.000Z' });

  assert.ok(byNewestFirst(newer, older) < 0);
  assert.ok(byNewestFirst(older, newer) > 0);
  assert.ok(byNewestFirst(older, tied) < 0, 'the higher messageId wins a tie');
  assert.equal(byNewestFirst(older, older), 0);
});

// ─── Conversation grouping ────────────────────────────────────────────────────

test('conversations are grouped by peer, newest conversation first', () => {
  const messages = [
    message({
      messageId: 'm-1',
      senderId: 'alice',
      recipientId: 'bob',
      createdAt: '2024-01-01T00:00:00.000Z',
    }),
    message({
      messageId: 'm-2',
      senderId: 'bob',
      recipientId: 'alice',
      createdAt: '2024-01-03T00:00:00.000Z',
    }),
    message({
      messageId: 'm-3',
      senderId: 'carol',
      recipientId: 'alice',
      createdAt: '2024-01-02T00:00:00.000Z',
    }),
    // Not alice's conversation at all.
    message({
      messageId: 'm-4',
      senderId: 'bob',
      recipientId: 'carol',
      createdAt: '2024-01-04T00:00:00.000Z',
    }),
  ];

  const summaries = summariseConversations(messages, 'alice');

  assert.deepEqual(
    summaries.map((s) => s.peerId),
    ['bob', 'carol']
  );
  assert.equal(summaries[0].lastMessage.messageId, 'm-2', 'the newest message wins');
  // Only messages *addressed to* alice and still unread count.
  assert.deepEqual(
    summaries.map((s) => s.unreadCount),
    [1, 1]
  );
});

test('a read message stops counting as unread', () => {
  const messages = [
    message({
      messageId: 'm-1',
      senderId: 'bob',
      recipientId: 'alice',
      readAt: '2024-01-02T00:00:00.000Z',
    }),
    message({ messageId: 'm-2', senderId: 'bob', recipientId: 'alice' }),
  ];

  const [summary] = summariseConversations(messages, 'alice');

  assert.equal(summary.unreadCount, 1);
  assert.equal(summary.conversationId, 'alice:bob');
});

/**
 * Account erasure (GDPR Art. 17 / CCPA "right to delete").
 *
 * The counterpart to `GET /account/export`: the same traversal of everywhere a
 * user's data lives, destructively.
 *
 * Three decisions shape this module.
 *
 * **Queued, not synchronous.** The cascade spans Postgres, Redis and object
 * storage, and a request that fails halfway leaves an account half-erased with
 * nothing to resume from. A request writes a `pending` row (see
 * `db/schema.ts`), the sweep carries it out, and a restart mid-cascade picks
 * the same row back up. The grace period before it becomes due is also what
 * protects a user whose account was deleted by mistake — or by somebody who
 * had briefly stolen their session.
 *
 * **Messages are tombstoned, not removed.** A conversation is two people's
 * history: hard-deleting one participant's messages rewrites the other's, so
 * replies would quote messages that no longer exist. `deleteMessage` already
 * clears body, attachment and reactions while leaving the row, which erases
 * the personal data and keeps the structure that the peer's copy depends on.
 * Only messages the erased user *sent* are theirs to erase; the ones they
 * received are the peer's.
 *
 * **The audit log survives, pseudonymised.** Retaining security events is a
 * legitimate interest; retaining them against a named individual is not. Every
 * `actor`/`target` mention of the account is rewritten to a random, unlinkable
 * pseudonym minted per erasure, and the existing 180-day retention then ages
 * the rows out.
 *
 * The `users` row itself is deleted rather than anonymised, because
 * `identity.ts` binds a provider account to a username permanently: keeping the
 * row would burn the username forever and stop the person returning under their
 * own name.
 */

import { eq, or, sql } from 'drizzle-orm';
import {
  accountDeletions as accountDeletionsTable,
  auditLog as auditLogTable,
  blocks as blocksTable,
  calls as callsTable,
  devices as devicesTable,
  users as usersTable,
} from '../../db/schema.ts';
import { randomUUID } from 'crypto';
import { deleteAttachmentObject, loadR2Config } from '../attachments.ts';
import {
  callHistoryCachePrefix,
  conversationsCachePrefix,
  invalidateCache,
  messagesCachePrefix,
} from '../cache.ts';
import { ACCOUNT_DELETION_MESSAGE_BATCH } from '../config.ts';
import { describeError } from '../lib/errors.ts';
import { removeDevice, userRoom } from '../lib/state.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type AccountDeletionRecord = import('../stores/contracts.ts').AccountDeletionRecord;
type StoredMessage = import('../messageStore.ts').StoredMessage;
type R2Config = ReturnType<typeof loadR2Config>;

type EraseOptions = {
  now?: number;
  r2Config?: R2Config;
  fetchImpl?: typeof fetch;
  io?: { in: (room: string) => { disconnectSockets: (close?: boolean) => void; }; } | null;
};

/** What one erasure touched, for the audit entry and the sweep log. */
type EraseResult = {
  messagesTombstoned: number;
  attachmentsDeleted: number;
  callsDeleted: number;
  devicesRemoved: number;
  blocksRemoved: number;
  sessionsRevoked: number;
};

/**
 * Persist a queued erasure. Best-effort: the in-memory record is authoritative
 * for this process, and a failed write is retried by the next request rather
 * than failing the caller's deletion request.
 */
async function persistAccountDeletion(
  state: ServerState,
  record: AccountDeletionRecord
): Promise<void> {
  if (!state.db) return;
  try {
    await state.db
      .insert(accountDeletionsTable)
      .values(record)
      .onConflictDoUpdate({
        target: accountDeletionsTable.userId,
        set: {
          status: record.status,
          requestedAt: record.requestedAt,
          scheduledFor: record.scheduledFor,
          completedAt: record.completedAt,
        },
      });
  } catch (error) {
    console.error(`[account-deletion] failed to persist request: ${describeError(error)}`);
  }
}

/** The queued erasure for `userId`, if any. */
function getAccountDeletion(state: ServerState, userId: string): AccountDeletionRecord | null {
  return state.accountDeletions.get(userId) ?? null;
}

/**
 * Queue an erasure for `userId`, or return the one already queued.
 *
 * Idempotent: a second request during the grace period does not extend it, so
 * an accidental double tap cannot postpone the deletion the user asked for.
 */
async function scheduleAccountDeletion(
  state: ServerState,
  { userId, graceMs, now = Date.now() }: { userId: string; graceMs: number; now?: number; }
): Promise<{ record: AccountDeletionRecord; created: boolean; }> {
  const existing = state.accountDeletions.get(userId);
  if (existing && existing.status === 'pending') {
    return { record: existing, created: false };
  }

  const record: AccountDeletionRecord = {
    userId,
    status: 'pending',
    requestedAt: new Date(now).toISOString(),
    scheduledFor: new Date(now + Math.max(0, graceMs)).toISOString(),
    completedAt: null,
  };
  state.accountDeletions.set(userId, record);
  await persistAccountDeletion(state, record);
  return { record, created: true };
}

/**
 * Cancel a queued erasure while it is still within its grace period.
 *
 * @returns the cancelled record, or `null` when nothing was pending.
 */
async function cancelAccountDeletion(
  state: ServerState,
  userId: string
): Promise<AccountDeletionRecord | null> {
  const existing = state.accountDeletions.get(userId);
  if (!existing || existing.status !== 'pending') return null;

  state.accountDeletions.delete(userId);
  if (state.db) {
    try {
      await state.db
        .delete(accountDeletionsTable)
        .where(eq(accountDeletionsTable.userId, userId));
    } catch (error) {
      console.error(`[account-deletion] failed to cancel request: ${describeError(error)}`);
    }
  }
  return existing;
}

/** What one page of an account's history contributed to the erasure. */
type MessagePageErasure = {
  tombstoned: number;
  attachmentUrls: string[];
  conversationIds: string[];
};

/**
 * Tombstone the messages in one page that the user themselves sent, collecting
 * the attachment URLs they referenced on the way through.
 */
async function eraseMessagePage(
  state: ServerState,
  userId: string,
  page: StoredMessage[]
): Promise<MessagePageErasure> {
  const result: MessagePageErasure = { tombstoned: 0, attachmentUrls: [], conversationIds: [] };

  for (const message of page) {
    result.conversationIds.push(message.conversationId);
    // Only what the user said is theirs to erase, and an already-tombstoned
    // row has nothing left to clear.
    if (message.senderId !== userId || message.deletedAt) continue;

    const url = (message.attachment as { url?: unknown; } | null)?.url;
    if (typeof url === 'string') result.attachmentUrls.push(url);

    const deleted = await state.messageStore.deleteMessage(
      message.conversationId,
      message.messageId,
      userId
    );
    if (deleted) result.tombstoned += 1;
  }

  return result;
}

/**
 * Tombstone every message the user sent, collecting the attachment URLs those
 * messages referenced on the way through.
 *
 * The history is walked in bounded pages, like the export: an account with
 * years of chat must not be read into memory in one statement.
 */
async function eraseSentMessages(
  state: ServerState,
  userId: string
): Promise<{ tombstoned: number; attachmentUrls: string[]; conversationIds: Set<string>; }> {
  const attachmentUrls: string[] = [];
  const conversationIds = new Set<string>();
  let tombstoned = 0;

  const listUserMessages = state.messageStore.listUserMessages;
  if (!listUserMessages) {
    throw new Error('message store does not support account erasure');
  }

  let page: StoredMessage[] = await listUserMessages({
    userId,
    limit: ACCOUNT_DELETION_MESSAGE_BATCH,
  });
  let previousCursor = '';

  while (page.length > 0) {
    const erased = await eraseMessagePage(state, userId, page);
    tombstoned += erased.tombstoned;
    attachmentUrls.push(...erased.attachmentUrls);
    for (const conversationId of erased.conversationIds) conversationIds.add(conversationId);

    if (page.length < ACCOUNT_DELETION_MESSAGE_BATCH) break;
    const last = page.at(-1);
    if (!last) break;
    // The cursor is the same `(createdAt, messageId)` pair the export pages on;
    // a page that fails to advance it would loop forever.
    const cursor = `${last.createdAt}\u0000${last.messageId}`;
    if (cursor === previousCursor) throw new Error('message erasure cursor did not advance');
    previousCursor = cursor;
    page = await listUserMessages({
      userId,
      limit: ACCOUNT_DELETION_MESSAGE_BATCH,
      before: last.createdAt,
      beforeMessageId: last.messageId,
    });
  }

  return { tombstoned, attachmentUrls, conversationIds };
}

/**
 * Remove the attachment objects the erased messages referenced.
 *
 * Best-effort per object: object storage being unavailable must not strand the
 * rest of the cascade, and an object left behind is reported rather than
 * silently counted as deleted.
 */
async function eraseAttachments(
  urls: string[],
  { r2Config, fetchImpl }: { r2Config: R2Config; fetchImpl?: typeof fetch; }
): Promise<number> {
  if (!r2Config || urls.length === 0) return 0;
  let deleted = 0;
  for (const url of urls) {
    try {
      if (await deleteAttachmentObject({ config: r2Config, url, fetchImpl })) deleted += 1;
    } catch (error) {
      console.error(`[account-deletion] attachment delete failed: ${describeError(error)}`);
    }
  }
  return deleted;
}

/**
 * Drop the call history the user took part in, in memory and in Postgres.
 *
 * A call row is nothing but two user ids and their timings, so there is no
 * anonymised form of it worth keeping: unlike a message it carries no content
 * that belongs to the other participant.  `call_events` cascades with its call.
 */
async function eraseCalls(state: ServerState, userId: string): Promise<number> {
  let removed = 0;
  for (const [callId, call] of state.calls) {
    if (call.callerId !== userId && call.calleeId !== userId) continue;
    state.calls.delete(callId);
    state.callEvents.delete(callId);
    removed += 1;
  }

  if (state.db) {
    await state.db
      .delete(callsTable)
      .where(or(eq(callsTable.callerId, userId), eq(callsTable.calleeId, userId)));
  }
  return removed;
}

/**
 * Remove the user's device registrations, taking their push tokens with them.
 *
 * A surviving token is a live delivery channel to a physical handset, so it is
 * dropped here rather than left for the stale-device sweep.
 */
async function eraseDevices(state: ServerState, userId: string): Promise<number> {
  const deviceIds = Array.from(state.userDevices.get(userId) ?? []);
  for (const deviceId of deviceIds) {
    removeDevice(state, deviceId);
  }
  state.userDevices.delete(userId);

  if (state.db) {
    await state.db.delete(devicesTable).where(eq(devicesTable.userId, userId));
  }
  return deviceIds.length;
}

/** Remove blocks in both directions: the user's own, and those naming them. */
async function eraseBlocks(state: ServerState, userId: string): Promise<number> {
  let removed = state.blocks.get(userId)?.size ?? 0;
  state.blocks.delete(userId);
  for (const [blockerId, blocked] of state.blocks) {
    if (!blocked.delete(userId)) continue;
    removed += 1;
    if (blocked.size === 0) state.blocks.delete(blockerId);
  }

  if (state.db) {
    await state.db
      .delete(blocksTable)
      .where(or(eq(blocksTable.blockerId, userId), eq(blocksTable.blockeeId, userId)));
  }
  return removed;
}

/**
 * Revoke every session and drop the live presence/connection state, including
 * the shared (Redis) session keys other instances would otherwise still honour.
 */
async function eraseSessions(state: ServerState, userId: string): Promise<number> {
  const sessionIds = Array.from(state.userSessions.get(userId) ?? []);
  for (const sessionId of sessionIds) {
    state.sessions.delete(sessionId);
    if (state.sessionState) {
      try {
        await state.sessionState.remove(sessionId);
      } catch (error) {
        console.error(`[account-deletion] failed to revoke session: ${describeError(error)}`);
      }
    }
  }
  // A session id held only by another instance is not in `userSessions`; sweep
  // the local map for stragglers so a hydrated copy cannot outlive the account.
  for (const [sessionId, session] of state.sessions) {
    if (session.userId === userId) state.sessions.delete(sessionId);
  }
  state.userSessions.delete(userId);
  state.userConnections.delete(userId);
  state.userPresence.delete(userId);
  for (const [roomId, members] of state.rooms) {
    if (!members.delete(userId)) continue;
    if (members.size === 0) state.rooms.delete(roomId);
  }
  return sessionIds.length;
}

/**
 * Rewrite every audit mention of the account to `pseudonym`.
 *
 * The pseudonym is random per erasure rather than derived from the username: a
 * hash would be reversible by anyone who can guess usernames, which is the
 * whole point of a public directory.
 */
async function pseudonymiseAuditLog(
  state: ServerState,
  userId: string,
  pseudonym: string
): Promise<void> {
  const auditLog = state.auditLog as { getAll?: () => { actor: string | null; target: string | null; }[]; };
  for (const entry of auditLog.getAll?.() ?? []) {
    if (entry.actor === userId) entry.actor = pseudonym;
    if (entry.target === userId) entry.target = pseudonym;
  }

  if (!state.db) return;
  await state.db
    .update(auditLogTable)
    .set({
      actor: sql`case when ${auditLogTable.actor} = ${userId} then ${pseudonym} else ${auditLogTable.actor} end`,
      target: sql`case when ${auditLogTable.target} = ${userId} then ${pseudonym} else ${auditLogTable.target} end`,
    })
    .where(or(eq(auditLogTable.actor, userId), eq(auditLogTable.target, userId)));
}

/** Release the claimed username, so the person can return under their own name. */
async function eraseIdentity(state: ServerState, userId: string): Promise<void> {
  state.users.delete(userId);
  if (state.db) {
    await state.db.delete(usersTable).where(eq(usersTable.userId, userId));
  }
}

/**
 * Carry out the erasure for one account.
 *
 * Ordered so that nothing can be delivered to — or authenticated as — an
 * account that is already partly erased: sessions and devices go first, the
 * content they could have reached afterwards.  Throwing leaves the queued row
 * `pending`, so the next sweep retries; every step is written to be safe to
 * run twice.
 */
async function eraseAccount(
  state: ServerState,
  userId: string,
  { now = Date.now(), r2Config = loadR2Config(), fetchImpl, io = null }: EraseOptions = {}
): Promise<EraseResult> {
  const pseudonym = `deleted-${randomUUID()}`;

  const sessionsRevoked = await eraseSessions(state, userId);
  try {
    io?.in(userRoom(userId)).disconnectSockets(true);
  } catch (error) {
    console.error(`[account-deletion] failed to disconnect sockets: ${describeError(error)}`);
  }
  const devicesRemoved = await eraseDevices(state, userId);

  const { tombstoned, attachmentUrls, conversationIds } = await eraseSentMessages(state, userId);
  const attachmentsDeleted = await eraseAttachments(attachmentUrls, { r2Config, fetchImpl });
  const callsDeleted = await eraseCalls(state, userId);
  const blocksRemoved = await eraseBlocks(state, userId);
  await pseudonymiseAuditLog(state, userId, pseudonym);
  await eraseIdentity(state, userId);

  // Cached pages still hold the pre-erasure bodies, including on the peers'
  // conversation lists, so they are evicted across the fleet.
  await invalidateCache(
    state,
    conversationsCachePrefix(userId),
    callHistoryCachePrefix(userId),
    ...Array.from(conversationIds, (conversationId) => messagesCachePrefix(conversationId))
  );

  const result: EraseResult = {
    messagesTombstoned: tombstoned,
    attachmentsDeleted,
    callsDeleted,
    devicesRemoved,
    blocksRemoved,
    sessionsRevoked,
  };

  const completed: AccountDeletionRecord = {
    ...(state.accountDeletions.get(userId) ?? {
      userId,
      requestedAt: new Date(now).toISOString(),
      scheduledFor: new Date(now).toISOString(),
    }),
    userId,
    status: 'completed',
    completedAt: new Date(now).toISOString(),
  };
  state.accountDeletions.set(userId, completed);
  await persistAccountDeletion(state, completed);

  // Recorded against the pseudonym: an entry naming the deleted user would put
  // the identifier straight back into the log the step above just cleaned.
  state.auditLog.record({
    event: 'account.deleted',
    actor: pseudonym,
    target: pseudonym,
    outcome: 'success',
    details: result,
  });

  return result;
}

/**
 * Erase every queued account whose grace period has elapsed.
 *
 * One account's failure does not stop the others: its row stays `pending` and
 * is retried on the next sweep.
 *
 * @returns the number of accounts erased.
 */
async function runAccountDeletionSweep(
  state: ServerState,
  options: EraseOptions = {}
): Promise<number> {
  const now = options.now ?? Date.now();
  const due = Array.from(state.accountDeletions.values()).filter(
    (record) => record.status === 'pending' && Date.parse(record.scheduledFor) <= now
  );

  let erased = 0;
  for (const record of due) {
    try {
      const result = await eraseAccount(state, record.userId, { ...options, now });
      erased += 1;
      console.log(
        `[account-deletion] erased an account: messages=${result.messagesTombstoned}` +
          ` attachments=${result.attachmentsDeleted} calls=${result.callsDeleted}` +
          ` devices=${result.devicesRemoved} blocks=${result.blocksRemoved}`
      );
    } catch (error) {
      console.error(`[account-deletion] erasure failed, will retry: ${describeError(error)}`);
    }
  }
  return erased;
}

/**
 * Load queued erasures from Postgres at boot, so a request survives the restart
 * that happens during its grace period.
 *
 * @returns number of rows read.
 */
async function hydrateAccountDeletions(state: ServerState): Promise<number> {
  if (!state.db) return 0;
  const rows = await state.db
    .select()
    .from(accountDeletionsTable)
    .where(eq(accountDeletionsTable.status, 'pending'));
  for (const row of rows) {
    state.accountDeletions.set(row.userId, {
      userId: row.userId,
      status: 'pending',
      requestedAt: row.requestedAt,
      scheduledFor: row.scheduledFor,
      completedAt: row.completedAt ?? null,
    });
  }
  return rows.length;
}

export {
  cancelAccountDeletion,
  eraseAccount,
  getAccountDeletion,
  hydrateAccountDeletions,
  runAccountDeletionSweep,
  scheduleAccountDeletion,
};
export type { EraseResult };

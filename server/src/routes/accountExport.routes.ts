import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { readAccountCallEvents } from '../domain/accountExport.ts';
import { readCallHistory } from '../domain/callHistory.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { describeError } from '../lib/errors.ts';
import { normaliseOptionalString } from '../lib/normalize.ts';
import { MAX_MESSAGE_LIMIT, clampMessageLimit } from '../messageStore.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type DeviceRecord = import('../stores/contracts.ts').DeviceRecord;

const DEFAULT_CALL_EXPORT_LIMIT = 50;
const MAX_CALL_EXPORT_LIMIT = 100;

function clampCallLimit(value: unknown): number {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_CALL_EXPORT_LIMIT;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_CALL_EXPORT_LIMIT);
}

function parseOffset(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
}

/**
 * Explicit projection: push tokens and the session bearer associated with a
 * device are credentials, not account data that should leave this boundary.
 */
function exportDevice(device: DeviceRecord) {
  return {
    deviceId: device.deviceId,
    userId: device.userId,
    platform: device.platform,
    pushProvider: device.pushProvider,
    lastRegisteredAt: device.lastRegisteredAt ?? null,
    lastUnregisteredAt: device.lastUnregisteredAt ?? null,
    updatedAt: device.updatedAt ?? null,
  };
}

function exportMessage(message: import('../messageStore.ts').StoredMessage) {
  const attachment = message.attachment as {
    url?: unknown;
  } | null;
  return {
    ...message,
    attachment: attachment
      ? {
          ...(typeof attachment.url === 'string' ? { url: attachment.url } : {}),
        }
      : null,
  };
}

function exportCall(call: import('../stores/contracts.ts').CallRecord) {
  return {
    callId: call.callId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    status: call.status,
    endReason: call.endReason ?? null,
    durationSeconds: call.durationSeconds ?? null,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt ?? null,
    missedReadAt: call.missedReadAt ?? null,
    ringTimeoutAt: call.ringTimeoutAt ?? null,
  };
}

function createAccountExportRouter({ state }: { state: ServerState }): import('express').Router {
  const router = express.Router();

  /**
   * GET /account/export
   *
   * A bounded, machine-readable export selected exclusively from the active
   * session's user id. Message pages use `before`; call pages use `callOffset`.
   * Attachment records contain object-storage URLs only—the server never
   * downloads or embeds attachment bytes or client-supplied metadata.
   */
  router.get(API_ROUTES.ACCOUNT_EXPORT, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const rateCheck = state.accountExportRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.max(1, Math.ceil((rateCheck.resetAt - Date.now()) / 1000)),
      });
      return;
    }

    const messageLimit = clampMessageLimit(req.query.limit);
    const before = normaliseOptionalString(req.query.before);
    const callLimit = clampCallLimit(req.query.callLimit);
    const callOffset = parseOffset(req.query.callOffset);

    let messageRows;
    try {
      if (!state.messageStore.listUserMessages) {
        throw new Error('message store does not support account exports');
      }
      // The extra row is never returned; it makes `hasMore` exact while keeping
      // the datastore read bounded to MAX_MESSAGE_LIMIT + 1.
      messageRows = await state.messageStore.listUserMessages({
        userId: session.userId,
        limit: Math.min(messageLimit + 1, MAX_MESSAGE_LIMIT + 1),
        before: before ?? undefined,
      });
    } catch (error) {
      console.error(`[account-export] message lookup failed: ${describeError(error)}`);
      res.status(503).json({ error: 'account export unavailable' });
      return;
    }

    // Defence in depth against an incorrectly scoped injected or remote store.
    const ownMessages = messageRows.filter(
      (message) =>
        message.senderId === session.userId || message.recipientId === session.userId
    );
    if (ownMessages.length !== messageRows.length) {
      console.error(
        `[account-export] dropped ${messageRows.length - ownMessages.length} non-participant message(s)`
      );
    }
    const hasMoreMessages = ownMessages.length > messageLimit;
    const messages = ownMessages.slice(0, messageLimit).map(exportMessage);

    const callPage = await readCallHistory(state, {
      userId: session.userId,
      limit: callLimit,
      offset: callOffset,
    });
    const calls = callPage.calls
      .filter((call) => call.callerId === session.userId || call.calleeId === session.userId)
      .map(exportCall);
    const callEvents = await readAccountCallEvents(
      state,
      calls.map((call) => call.callId)
    );

    const profile = state.users.get(session.userId);
    const devices = Array.from(state.devices.values())
      .filter((device) => device.userId === session.userId)
      .map(exportDevice);
    const blocks = Array.from(state.blocks.get(session.userId) ?? []);

    // Record before taking the audit snapshot so the delivered export contains
    // its own access record. Failed exports are deliberately not called exported.
    state.auditLog.record({
      event: 'account.exported',
      actor: session.userId,
      target: session.userId,
      outcome: 'success',
      details: { messageCount: messages.length, callCount: calls.length },
    });
    const audit = state.auditLog.getForUser(session.userId);

    res.status(200).json({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      userId: session.userId,
      profile: {
        userId: session.userId,
        email: profile?.email ?? null,
        authProvider: profile?.authProvider ?? null,
        createdAt: profile?.createdAt ?? null,
        verifiedAt: profile?.verifiedAt ?? null,
      },
      messages,
      calls,
      callEvents,
      devices,
      blocks,
      auditLog: audit,
      pagination: {
        messages: {
          limit: messageLimit,
          before: before ?? null,
          hasMore: hasMoreMessages,
          nextBefore:
            hasMoreMessages && messages.length > 0
              ? messages[messages.length - 1].createdAt
              : null,
        },
        calls: {
          limit: callLimit,
          offset: callOffset,
          total: callPage.total,
          hasMore: callOffset + calls.length < callPage.total,
          nextOffset:
            callOffset + calls.length < callPage.total
              ? callOffset + calls.length
              : null,
        },
      },
    });
  });

  return router;
}

export { createAccountExportRouter };

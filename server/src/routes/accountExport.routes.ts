import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { readAccountCallEvents } from '../domain/accountExport.ts';
import { readCallHistory } from '../domain/callHistory.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { describeError } from '../lib/errors.ts';
import { clampMessageLimit } from '../messageStore.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type DeviceRecord = import('../stores/contracts.ts').DeviceRecord;
type CallRecord = import('../stores/contracts.ts').CallRecord;
type CallHistoryPage = import('../domain/callHistory.ts').CallHistoryPage;
type StoredMessage = import('../messageStore.ts').StoredMessage;
type Response = import('express').Response;

const DEFAULT_CALL_EXPORT_PAGE_SIZE = 50;
const MAX_CALL_EXPORT_PAGE_SIZE = 100;

function clampCallPageSize(value: unknown): number {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_CALL_EXPORT_PAGE_SIZE;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_CALL_EXPORT_PAGE_SIZE);
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/**
 * Honour HTTP backpressure so a slow archive download cannot make buffered
 * response chunks grow with the size of the account.
 */
async function writeChunk(res: Response, chunk: string): Promise<void> {
  if (res.destroyed) throw new Error('account export client disconnected');
  if (res.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('account export client disconnected'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

async function writeArrayValues(
  res: Response,
  values: unknown[],
  firstValue: boolean
): Promise<{ firstValue: boolean; count: number; }> {
  let isFirst = firstValue;
  for (const value of values) {
    await writeChunk(res, `${isFirst ? '' : ','}${json(value)}`);
    isFirst = false;
  }
  return { firstValue: isFirst, count: values.length };
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

function exportMessage(message: StoredMessage) {
  const attachment = message.attachment as { url?: unknown; } | null;
  return {
    ...message,
    attachment: attachment
      ? {
          ...(typeof attachment.url === 'string' ? { url: attachment.url } : {}),
        }
      : null,
  };
}

function exportCall(call: CallRecord) {
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

function ownMessages(rows: StoredMessage[], userId: string): StoredMessage[] {
  const own = rows.filter(
    (message) => message.senderId === userId || message.recipientId === userId
  );
  if (own.length !== rows.length) {
    console.error(
      `[account-export] dropped ${rows.length - own.length} non-participant message(s)`
    );
  }
  return own;
}

function ownCalls(rows: CallRecord[], userId: string): CallRecord[] {
  return rows.filter((call) => call.callerId === userId || call.calleeId === userId);
}

async function readMessagePage(
  state: ServerState,
  userId: string,
  pageSize: number,
  before?: string,
  beforeMessageId?: string
): Promise<StoredMessage[]> {
  if (!state.messageStore.listUserMessages) {
    throw new Error('message store does not support account exports');
  }
  return state.messageStore.listUserMessages({
    userId,
    limit: pageSize,
    before,
    beforeMessageId,
  });
}

async function streamMessages(
  res: Response,
  state: ServerState,
  userId: string,
  pageSize: number,
  initialRows: StoredMessage[]
): Promise<number> {
  let rows = initialRows;
  let firstValue = true;
  let count = 0;
  let previousCursor = '';

  while (rows.length > 0) {
    const written = await writeArrayValues(
      res,
      ownMessages(rows, userId).map(exportMessage),
      firstValue
    );
    firstValue = written.firstValue;
    count += written.count;
    if (rows.length < pageSize) break;

    const last = rows.at(-1);
    if (!last) break;
    const cursor = `${last.createdAt}\u0000${last.messageId}`;
    if (cursor === previousCursor) throw new Error('message export cursor did not advance');
    previousCursor = cursor;
    rows = await readMessagePage(state, userId, pageSize, last.createdAt, last.messageId);
  }

  return count;
}

async function streamCalls(
  res: Response,
  state: ServerState,
  userId: string,
  pageSize: number,
  initialPage: CallHistoryPage
): Promise<number> {
  let page = initialPage;
  let offset = 0;
  let firstValue = true;
  let count = 0;

  while (page.calls.length > 0) {
    const written = await writeArrayValues(
      res,
      ownCalls(page.calls, userId).map(exportCall),
      firstValue
    );
    firstValue = written.firstValue;
    count += written.count;
    offset += page.calls.length;
    if (page.calls.length < pageSize) break;
    page = await readCallHistory(state, { userId, limit: pageSize, offset });
  }

  return count;
}

async function streamCallEvents(
  res: Response,
  state: ServerState,
  userId: string,
  pageSize: number,
  initialPage: CallHistoryPage
): Promise<void> {
  let page = initialPage;
  let offset = 0;
  let firstValue = true;

  while (page.calls.length > 0) {
    const calls = ownCalls(page.calls, userId);
    const events = await readAccountCallEvents(
      state,
      calls.map((call) => call.callId)
    );
    ({ firstValue } = await writeArrayValues(res, events, firstValue));
    offset += page.calls.length;
    if (page.calls.length < pageSize) break;
    page = await readCallHistory(state, { userId, limit: pageSize, offset });
  }
}

function profileFor(state: ServerState, userId: string) {
  const profile = state.users.get(userId);
  return {
    userId,
    email: profile?.email ?? null,
    authProvider: profile?.authProvider ?? null,
    createdAt: profile?.createdAt ?? null,
    verifiedAt: profile?.verifiedAt ?? null,
  };
}

function destroyOrReportUnavailable(res: Response, error: unknown): void {
  console.error(`[account-export] generation failed: ${describeError(error)}`);
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  res.status(503).json({ error: 'account export unavailable' });
}

function createAccountExportRouter({ state }: { state: ServerState }): import('express').Router {
  const router = express.Router();

  /**
   * GET /account/export
   *
   * One request produces a complete archive. Messages, calls, and call events
   * are read and emitted in bounded pages; attachment records contain only
   * object-storage URLs, never bytes or client-supplied metadata.
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

    const messagePageSize = clampMessageLimit(req.query.limit);
    const callPageSize = clampCallPageSize(req.query.callLimit);

    try {
      // Read one bounded page before sending headers so an unavailable message
      // store can still produce a well-formed 503 response.
      const firstMessages = await readMessagePage(
        state,
        session.userId,
        messagePageSize
      );
      const firstCalls = await readCallHistory(state, {
        userId: session.userId,
        limit: callPageSize,
        offset: 0,
      });
      const exportedAt = new Date().toISOString();
      const prefix = json({
        schemaVersion: 1,
        exportedAt,
        userId: session.userId,
        profile: profileFor(state, session.userId),
      });

      res.status(200).type('application/json');
      await writeChunk(res, `${prefix.slice(0, -1)},"messages":[`);
      const messageCount = await streamMessages(
        res,
        state,
        session.userId,
        messagePageSize,
        firstMessages
      );
      await writeChunk(res, '],"calls":[');
      const callCount = await streamCalls(
        res,
        state,
        session.userId,
        callPageSize,
        firstCalls
      );
      await writeChunk(res, '],"callEvents":[');
      await streamCallEvents(res, state, session.userId, callPageSize, firstCalls);

      const devices = Array.from(state.devices.values())
        .filter((device) => device.userId === session.userId)
        .map(exportDevice);
      const blocks = Array.from(state.blocks.get(session.userId) ?? []);
      state.auditLog.record({
        event: 'account.exported',
        actor: session.userId,
        target: session.userId,
        outcome: 'success',
        details: { messageCount, callCount },
      });
      const auditLog = state.auditLog.getForUser(session.userId);
      const pagination = {
        messages: {
          limit: messagePageSize,
          before: null,
          hasMore: false,
          nextBefore: null,
        },
        calls: {
          limit: callPageSize,
          offset: 0,
          total: firstCalls.total,
          hasMore: false,
          nextOffset: null,
        },
      };

      await writeChunk(
        res,
        `],"devices":${json(devices)},"blocks":${json(blocks)},"auditLog":${json(
          auditLog
        )},"pagination":${json(pagination)}}`
      );
      res.end();
    } catch (error) {
      destroyOrReportUnavailable(res, error);
    }
  });

  return router;
}

export { createAccountExportRouter };

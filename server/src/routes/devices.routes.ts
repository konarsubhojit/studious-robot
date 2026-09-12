import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { getSessionFromRequest } from '../lib/auth.ts';
import { normaliseId, normalisePushProvider, sanitizeForLog } from '../lib/normalize.ts';
import { upsertDevice } from '../lib/state.ts';
import { persistDevice } from '../lib/persistence.ts';
import type { Database } from '../../db/client.ts';

// Delivery stages report that a call push reached the device and rang it;
// answer stages report what happened when the user tapped Answer, so a call
// that rings but cannot be picked up is visible in server logs (previously the
// server saw nothing at all between `ringing` and `timeout`).
// The last five stages below time the callee's own work *after* the accept is
// acknowledged — permissions, camera, peer connection, answer — which runs
// entirely inside `accepted -> in_call` and was previously invisible to the
// server (`docs/media-connect-latency-diagnosis.md` §6). `media_connected`
// closes that window and reports the ICE outcome the server cannot see (§4).
const PUSH_RECEIPT_STAGES = new Set([
  'received',
  'ui_displayed',
  'ui_failed',
  'answer_attempted',
  'answer_failed',
  'answer_accepted',
  'answer_skipped_duplicate',
  'accept_tapped',
  'decline_tapped',
  'permissions_checked',
  'media_acquired',
  'peer_connection_ready',
  'offer_sent',
  'answer_sent',
  'media_connected',
  'connection_created',
]);

/**
 * Ceiling on a client-reported stage duration, in ms.
 *
 * The value is measured on the handset and sent over an unauthenticated-ish
 * receipt, so it is attacker-influenced: bound it rather than logging whatever
 * arrives. Ten minutes is far past any stage that could still matter — the
 * call it belongs to was force-ended long before.
 */
const MAX_RECEIPT_DURATION_MS = 10 * 60 * 1000;

/**
 * A device-measured stage duration, or `null` when absent or out of bounds.
 *
 * Distinct from the server-computed `latencyMs`, which is measured from the
 * call record and therefore cannot see how long any one client-side step took.
 */
function normaliseReceiptDuration(value: unknown): number | null {
  const durationMs = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(durationMs)) return null;
  if (durationMs < 0 || durationMs > MAX_RECEIPT_DURATION_MS) return null;
  return Math.round(durationMs);
}

// Message pushes are data-only, so the client renders the notification itself
// and "accepted by provider" proves nothing about the handset. These stages are
// what makes a message that never surfaced distinguishable from one that did.
const MESSAGE_RECEIPT_STAGES = new Set([
  'received',
  'notification_shown',
  'notification_failed',
  'notification_suppressed',
]);

/**
 * Device push-token registration / unregistration.
 */
/**
 * The receipt log line.
 *
 * Extracted from the handler so the route reads as validate-resolve-report;
 * the formatting is where most of its branching lived.
 *
 * `latencyMs` is the server's own measurement from the call record and
 * `durationMs` the device's measurement of the step being reported, so both
 * are logged and neither substitutes for the other.
 */
function formatReceiptLog({
  callId,
  messageId,
  deviceId,
  stage,
  reason,
  latencyMs,
  durationMs,
}: {
  callId: string | null;
  messageId: string | null;
  deviceId: string;
  stage: string;
  reason: string | null;
  latencyMs: number | null;
  durationMs: number | null;
}): string {
  return (
    `[push] Receipt ${callId ? 'callId' : 'messageId'}=${sanitizeForLog(callId || messageId)}` +
    ` device=${sanitizeForLog(deviceId)}` +
    ` stage=${sanitizeForLog(stage)}` +
    (reason ? ` reason=${sanitizeForLog(reason)}` : '') +
    ` latencyMs=${latencyMs ?? 'N/A'}` +
    (durationMs === null ? '' : ` durationMs=${durationMs}`)
  );
}

function createDevicesRouter({ state, db }: { state: import('../stores/contracts.ts').ServerState; db: Database | null; }): import('express').Router {
  const router = express.Router();

  router.post(API_ROUTES.DEVICES_REGISTER, async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const provider = normalisePushProvider(req.body?.provider);
    const pushToken = normaliseId(req.body?.pushToken);
    const requestedDeviceId = normaliseId(req.body?.deviceId);
    if (!provider || !pushToken) {
      res.status(400).json({ error: 'provider and pushToken are required' });
      return;
    }
    if (requestedDeviceId && requestedDeviceId !== session.deviceId) {
      res.status(400).json({ error: 'deviceId does not match active session' });
      return;
    }

    const device = upsertDevice(state, {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      pushProvider: provider,
      pushToken,
      lastRegisteredAt: new Date().toISOString(),
      lastUnregisteredAt: null,
    });

    // Persist device push-token registration to DB so it survives restarts.
    await persistDevice(db, device, 'registration');

    res.status(200).json({
      status: 'registered',
      userId: device.userId,
      deviceId: device.deviceId,
      provider: device.pushProvider,
    });
  });

  router.post(API_ROUTES.DEVICES_UNREGISTER, async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const requestedDeviceId = normaliseId(req.body?.deviceId);
    if (requestedDeviceId && requestedDeviceId !== session.deviceId) {
      res.status(400).json({ error: 'deviceId does not match active session' });
      return;
    }

    const device = upsertDevice(state, {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      pushProvider: null,
      pushToken: null,
      lastUnregisteredAt: new Date().toISOString(),
    });

    // Persist the cleared push-token record to DB so the unregistration
    // survives restarts and push deliveries stop immediately.
    await persistDevice(db, device, 'unregistration');

    res.status(200).json({
      status: 'unregistered',
      userId: device.userId,
      deviceId: device.deviceId,
    });
  });

  router.post(API_ROUTES.DEVICES_PUSH_RECEIPT, async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    const deviceId = session?.deviceId || normaliseId(req.body?.deviceId);
    const callId = normaliseId(req.body?.callId);
    const messageId = normaliseId(req.body?.messageId);
    const stage = normaliseId(req.body?.stage);
    const reason = normaliseId(req.body?.reason);
    const durationMs = normaliseReceiptDuration(req.body?.durationMs);

    if (!deviceId) {
      res.status(400).json({ error: 'sessionId or deviceId is required' });
      return;
    }
    if (!callId && !messageId) {
      res.status(400).json({ error: 'callId or messageId is required' });
      return;
    }
    const allowedStages = callId ? PUSH_RECEIPT_STAGES : MESSAGE_RECEIPT_STAGES;
    if (!stage || !allowedStages.has(stage)) {
      res.status(400).json({ error: 'invalid stage' });
      return;
    }

    // Only calls are tracked long enough to time the push against; message
    // receipts report the stage alone. The local registry is consulted first,
    // then the shared record: a call created on another instance is absent from
    // this process's map, which used to report `latencyMs=N/A` for exactly the
    // cross-instance pushes worth measuring.
    let call = callId ? state.calls.get(callId) || null : null;
    if (callId && !call && state.callState) {
      call = await state.callState.get(callId).catch(() => null);
    }
    const createdAtMs = call?.createdAt ? new Date(call.createdAt).getTime() : NaN;
    const latencyMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : null;
    console.log(
      formatReceiptLog({ callId, messageId, deviceId, stage, reason, latencyMs, durationMs })
    );

    res.status(202).json({
      status: 'recorded',
      ...(callId ? { callId } : { messageId }),
      deviceId,
      stage,
      ...(reason ? { reason } : {}),
      latencyMs,
      ...(durationMs === null ? {} : { durationMs }),
    });
  });

  return router;
}

export { createDevicesRouter };

'use strict';

const express = require('express');
const { API_ROUTES } = require('../../../shared');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normalisePushProvider, sanitizeForLog } = require('../lib/normalize');
const { upsertDevice } = require('../lib/state');
const { persistDevice } = require('../lib/persistence');

// Delivery stages report that a call push reached the device and rang it;
// answer stages report what happened when the user tapped Answer, so a call
// that rings but cannot be picked up is visible in server logs (previously the
// server saw nothing at all between `ringing` and `timeout`).
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
]);

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
 *
 * @param {{ state: object, db: object|null }} ctx
 * @returns {import('express').Router}
 */
function createDevicesRouter({ state, db }) {
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

  router.post(API_ROUTES.DEVICES_PUSH_RECEIPT, (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    const deviceId = session?.deviceId || normaliseId(req.body?.deviceId);
    const callId = normaliseId(req.body?.callId);
    const messageId = normaliseId(req.body?.messageId);
    const stage = normaliseId(req.body?.stage);
    const reason = normaliseId(req.body?.reason);

    if (!deviceId) {
      res.status(400).json({ error: 'sessionId or deviceId is required' });
      return;
    }
    if (!callId && !messageId) {
      res.status(400).json({ error: 'callId or messageId is required' });
      return;
    }
    const allowedStages = callId ? PUSH_RECEIPT_STAGES : MESSAGE_RECEIPT_STAGES;
    if (!allowedStages.has(stage)) {
      res.status(400).json({ error: 'invalid stage' });
      return;
    }

    // Only calls are tracked in memory long enough to time the push against;
    // message receipts report the stage alone.
    const call = callId ? state.calls.get(callId) || null : null;
    const createdAtMs = call?.createdAt ? new Date(call.createdAt).getTime() : NaN;
    const latencyMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : null;
    console.log(
      `[push] Receipt ${callId ? 'callId' : 'messageId'}=${sanitizeForLog(callId || messageId)}` +
        ` device=${sanitizeForLog(deviceId)}` +
        ` stage=${sanitizeForLog(stage)}` +
        (reason ? ` reason=${sanitizeForLog(reason)}` : '') +
        ` latencyMs=${latencyMs ?? 'N/A'}`
    );

    res.status(202).json({
      status: 'recorded',
      ...(callId ? { callId } : { messageId }),
      deviceId,
      stage,
      ...(reason ? { reason } : {}),
      latencyMs,
    });
  });

  return router;
}

module.exports = { createDevicesRouter };

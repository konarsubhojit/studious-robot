'use strict';

const express = require('express');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normalisePushProvider, sanitizeForLog } = require('../lib/normalize');
const { upsertDevice } = require('../lib/state');
const { persistDevice } = require('../lib/persistence');

const PUSH_RECEIPT_STAGES = new Set(['received', 'ui_displayed', 'ui_failed']);

/**
 * Device push-token registration / unregistration.
 *
 * @param {{ state: object, db: object|null }} ctx
 * @returns {import('express').Router}
 */
function createDevicesRouter({ state, db }) {
  const router = express.Router();

  router.post('/devices/register', async (req, res) => {
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

  router.post('/devices/unregister', async (req, res) => {
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

  router.post('/devices/push-receipt', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    const deviceId = session?.deviceId || normaliseId(req.body?.deviceId);
    const callId = normaliseId(req.body?.callId);
    const stage = normaliseId(req.body?.stage);

    if (!deviceId) {
      res.status(400).json({ error: 'sessionId or deviceId is required' });
      return;
    }
    if (!callId) {
      res.status(400).json({ error: 'callId is required' });
      return;
    }
    if (!PUSH_RECEIPT_STAGES.has(stage)) {
      res.status(400).json({ error: 'invalid stage' });
      return;
    }

    const call = state.calls.get(callId) || null;
    const createdAtMs = call?.createdAt ? new Date(call.createdAt).getTime() : NaN;
    const latencyMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : null;
    console.log(
      `[push] Receipt callId=${sanitizeForLog(callId)}` +
        ` device=${sanitizeForLog(deviceId)}` +
        ` stage=${sanitizeForLog(stage)}` +
        ` latencyMs=${latencyMs ?? 'N/A'}`
    );

    res.status(202).json({
      status: 'recorded',
      callId,
      deviceId,
      stage,
      latencyMs,
    });
  });

  return router;
}

module.exports = { createDevicesRouter };

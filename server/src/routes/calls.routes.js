'use strict';

const express = require('express');
const { timingSafeEqual } = require('crypto');
const { isBlocked } = require('../security');
const { callHistoryCacheKey, readCached, writeCached } = require('../cache');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId } = require('../lib/normalize');
const {
  createCallRecord,
  transitionCall,
  describeActiveCallsForUser,
} = require('../domain/calls');
const { notifyCallCreated, notifyCallTransition } = require('../domain/notifications');

/**
 * Constant-time check of the operator debug token, so `/debug/active-calls`
 * can be used to inspect another user without leaking the token via timing.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasDebugToken(req) {
  const expected = process.env.DEBUG_API_TOKEN;
  if (!expected) return false;
  const presented = req.get('x-debug-token') ?? '';
  const expectedBuffer = Buffer.from(expected);
  const presentedBuffer = Buffer.from(presented);
  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, presentedBuffer);
}

/**
 * Call lifecycle endpoints: create, inspect, history, and state transitions.
 *
 * Needs the live Socket.IO server (`io`) for realtime notifications, so it must
 * be mounted after `io` is created.
 *
 * @param {{ state: object, io: object, ringingTimeoutMs: number }} ctx
 * @returns {import('express').Router}
 */
function createCallsRouter({ state, io, ringingTimeoutMs }) {
  const router = express.Router();

  router.post('/calls', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const calleeId = normaliseId(req.body?.calleeId);
    if (!calleeId) {
      res.status(400).json({ error: 'calleeId is required' });
      return;
    }

    if (calleeId === session.userId) {
      res.status(400).json({ error: 'cannot call yourself' });
      return;
    }

    // Blocklist: reject when the callee has blocked the caller.
    if (isBlocked(state.blocks, calleeId, session.userId)) {
      state.auditLog.record({
        event: 'call.blocked',
        actor: session.userId,
        target: calleeId,
        outcome: 'rejected',
        details: { via: 'http' },
      });
      console.log(
        `[security] call.blocked callerId=${session.userId} calleeId=${calleeId} via=http`
      );
      res.status(403).json({ error: 'blocked' });
      return;
    }

    // Rate limit: cap call initiations per user per window.
    const rateCheck = state.callInitRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      state.auditLog.record({
        event: 'call.rate_limited',
        actor: session.userId,
        outcome: 'rejected',
        details: { via: 'http' },
      });
      console.log(`[security] call.rate_limited userId=${session.userId} via=http`);
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
      });
      return;
    }

    const call = createCallRecord(state, {
      callerId: session.userId,
      calleeId,
      ringingTimeoutMs,
    });
    notifyCallCreated(io, state, call);

    res.status(201).json(call);
  });

  router.get('/calls/:callId', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId && call.calleeId !== session.userId) {
      res.status(403).json({ error: 'not a participant in this call' });
      return;
    }

    res.status(200).json(call);
  });

  /**
   * GET /calls/:callId/events
   *
   * Returns the ordered event timeline for a call.  Each entry records which
   * state transition occurred, who triggered it, and when – giving on-call
   * engineers a full tracing timeline to diagnose failed or degraded calls.
   *
   * Requires an authenticated session that belongs to a call participant.
   */
  router.get('/calls/:callId/events', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId && call.calleeId !== session.userId) {
      res.status(403).json({ error: 'not a participant in this call' });
      return;
    }

    const events = state.callEvents.get(call.callId) ?? [];
    res.status(200).json({ callId: call.callId, events });
  });

  /**
   * GET /calls – return the call history for the authenticated user.
   *
   * Query parameters:
   *   limit  – max number of records to return (1–100, default 20)
   *   status – optional filter by call status (e.g. "missed", "ended")
   *
   * Records are ordered by `createdAt` descending (most recent first).
   */
  router.get('/calls', async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
    const statusFilter = normaliseId(req.query.status) ?? null;

    const userId = session.userId;
    const cacheKey = callHistoryCacheKey(userId, statusFilter, limit);
    const cached = await readCached(state, cacheKey);
    if (cached) {
      res.status(200).json(cached);
      return;
    }

    const userCalls = [];
    for (const call of state.calls.values()) {
      if (call.callerId !== userId && call.calleeId !== userId) continue;
      if (statusFilter && call.status !== statusFilter) continue;
      userCalls.push(call);
    }

    userCalls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const payload = {
      calls: userCalls.slice(0, limit),
      total: userCalls.length,
    };
    await writeCached(state, cacheKey, payload);
    res.status(200).json(payload);
  });

  /**
   * GET /debug/active-calls/:userId
   *
   * Inspect exactly what is keeping a user busy: every non-terminal call they
   * participate in, with its status and age.  A `busy` rejection is otherwise
   * undiagnosable from the outside.
   *
   * Requires an authenticated session; a user may only inspect themselves
   * unless the request carries the operator token (`DEBUG_API_TOKEN`).
   */
  router.get('/debug/active-calls/:userId', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const userId = normaliseId(req.params.userId) ?? '';
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    if (userId !== session.userId && !hasDebugToken(req)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const activeCalls = describeActiveCallsForUser(state, userId);
    res.status(200).json({ userId, activeCalls, total: activeCalls.length });
  });

  router.post('/calls/:callId/accept', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.calleeId !== session.userId) {
      res.status(403).json({ error: 'only the callee can accept a call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'accepted', { actor: session.userId });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
      });
    }

    res.status(200).json(result.call);
  });

  router.post('/calls/:callId/decline', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.calleeId !== session.userId) {
      res.status(403).json({ error: 'only the callee can decline a call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'declined', {
      actor: session.userId,
      reason: 'declined',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'declined',
      });
    }

    res.status(200).json(result.call);
  });

  router.post('/calls/:callId/cancel', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId) {
      res.status(403).json({ error: 'only the caller can cancel a call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'cancelled',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'cancelled',
      });
    }

    res.status(200).json(result.call);
  });

  router.post('/calls/:callId/end', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId && call.calleeId !== session.userId) {
      res.status(403).json({ error: 'not a participant in this call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'ended',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'ended',
      });
    }

    res.status(200).json(result.call);
  });

  return router;
}

module.exports = { createCallsRouter };

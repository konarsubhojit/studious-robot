import express from 'express';
import { timingSafeEqual } from 'crypto';
import { isBlocked } from '../security.ts';
import { callHistoryCacheKey, readCached, writeCached } from '../cache.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId, sanitizeForLog } from '../lib/normalize.ts';
import { describeActiveCallsForUser, ownerDeviceIdForUser } from '../domain/calls.ts';
import {
  hydrateCallFromShared,
  placeCallWithShared,
  transitionCallWithShared,
} from '../domain/sharedCalls.ts';
import { readCallHistory } from '../domain/callHistory.ts';
import { notifyCallCreated, notifyCallTransition } from '../domain/notifications.ts';

/**
 * Constant-time check of the operator debug token, so `/debug/active-calls`
 * can be used to inspect another user without leaking the token via timing.
 */
function hasDebugToken(req: import('express').Request): boolean {
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
 */
function createCallsRouter({ state, io, ringingTimeoutMs }: { state: import('../stores/contracts.ts').ServerState; io: any; ringingTimeoutMs: number; }): import('express').Router {
  const router = express.Router();

  router.post('/calls', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
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

    const result = await placeCallWithShared(state, {
      callerId: session.userId,
      calleeId,
      ringingTimeoutMs,
      callerDeviceId: session.deviceId ?? null,
      onSuperseded: (superseded, previousStatus, reason) => {
        notifyCallTransition(io, state, superseded, {
          previousStatus,
          actor: session.userId,
          reason,
        });
      },
    });

    if (!result.ok) {
      console.log(
        `[calls] POST /calls rejected callerId=${sanitizeForLog(session.userId)}` +
          ` calleeId=${sanitizeForLog(calleeId)} reason=call_in_progress` +
          ` activeCallId=${result.call.callId} peerId=${sanitizeForLog(result.peerId)}`
      );
      res.status(409).json({
        error: 'call_in_progress',
        message: 'you are already in a call',
        activeCallId: result.call.callId,
        peerId: result.peerId,
      });
      return;
    }

    const call = result.call;
    notifyCallCreated(io, state, call);

    res.status(201).json(call);
  });

  router.get('/calls/:callId', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = await hydrateCallFromShared(state, normaliseId(req.params.callId) ?? '');
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
  router.get('/calls/:callId/events', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = await hydrateCallFromShared(state, normaliseId(req.params.callId) ?? '');
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
   *   offset – how many records to skip (default 0), for paging
   *   status – optional filter by call status (e.g. "missed", "ended")
   *
   * History is read from the durable `calls` table (see
   * `domain/callHistory.ts`), so it survives a restart and is not bounded by
   * the in-memory retention window.  Records are ordered by `updatedAt`
   * descending (most recently active first).
   *
   * Only the first page is cached: deeper pages are rare and unbounded in key
   * space, matching how `GET /messages` treats deep pagination.
   */
  router.get('/calls', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const limitParam = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
    const offsetParam = parseInt(String(req.query.offset ?? ''), 10);
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;
    const statusFilter = normaliseId(req.query.status) ?? null;

    const userId = session.userId;
    const cacheKey = offset === 0 ? callHistoryCacheKey(userId, statusFilter, limit) : null;
    if (cacheKey) {
      const cached = await readCached(state, cacheKey);
      if (cached) {
        res.status(200).json(cached);
        return;
      }
    }

    const page = await readCallHistory(state, { userId, statusFilter, limit, offset });

    const payload = {
      calls: page.calls,
      total: page.total,
      limit,
      offset,
      hasMore: offset + page.calls.length < page.total,
    };
    if (cacheKey) await writeCached(state, cacheKey, payload);
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
  router.get('/debug/active-calls/:userId', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
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

  router.post('/calls/:callId/accept', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = await hydrateCallFromShared(state, normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.calleeId !== session.userId) {
      res.status(403).json({ error: 'only the callee can accept a call' });
      return;
    }

    const owner = ownerDeviceIdForUser(call, session.userId);
    if (owner && session.deviceId && owner !== session.deviceId) {
      res.status(409).json({
        error: 'answered_elsewhere',
        message: 'this call was answered on another device',
      });
      return;
    }

    const previousStatus = call.status;
    const result = await transitionCallWithShared(state, call.callId, 'accepted', {
      actor: session.userId,
      actorDeviceId: session.deviceId ?? null,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (!result.stale && previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
      });
    }

    res.status(200).json(result.call);
  });

  router.post('/calls/:callId/decline', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = await hydrateCallFromShared(state, normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.calleeId !== session.userId) {
      res.status(403).json({ error: 'only the callee can decline a call' });
      return;
    }

    const previousStatus = call.status;
    const result = await transitionCallWithShared(state, call.callId, 'declined', {
      actor: session.userId,
      reason: 'declined',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (!result.stale && previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'declined',
      });
    }

    res.status(200).json(result.call);
  });

  router.post('/calls/:callId/cancel', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = await hydrateCallFromShared(state, normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId) {
      res.status(403).json({ error: 'only the caller can cancel a call' });
      return;
    }

    const previousStatus = call.status;
    const result = await transitionCallWithShared(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'cancelled',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (!result.stale && previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'cancelled',
      });
    }

    res.status(200).json(result.call);
  });

  router.post('/calls/:callId/end', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = await hydrateCallFromShared(state, normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId && call.calleeId !== session.userId) {
      res.status(403).json({ error: 'not a participant in this call' });
      return;
    }

    const previousStatus = call.status;
    const result = await transitionCallWithShared(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'ended',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (!result.stale && previousStatus !== result.call.status) {
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

export { createCallsRouter };

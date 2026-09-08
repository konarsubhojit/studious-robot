import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import {
  cancelAccountDeletion,
  getAccountDeletion,
  scheduleAccountDeletion,
} from '../domain/accountDeletion.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { describeError } from '../lib/errors.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type AccountDeletionRecord = import('../stores/contracts.ts').AccountDeletionRecord;

/** Public shape of a queued erasure; there is nothing here to hide from its owner. */
function describeRecord(record: AccountDeletionRecord) {
  return {
    status: record.status,
    requestedAt: record.requestedAt,
    scheduledFor: record.scheduledFor,
    completedAt: record.completedAt,
  };
}

/**
 * Account erasure requests (`/account/delete`).
 *
 * The request only *queues* the erasure — see `domain/accountDeletion.ts` for
 * why, and for what the cascade covers.  Until `scheduledFor` passes, the
 * account works normally and the owner can cancel; that grace period is the
 * only defence a user has against a deletion they did not intend, or one made
 * by somebody who briefly held their session.
 */
function createAccountDeletionRouter({
  state,
  graceMs,
}: { state: ServerState; graceMs: number; }): import('express').Router {
  const router = express.Router();

  /**
   * POST /account/delete
   *
   * Queue this account for erasure.  Idempotent: repeating the request returns
   * the pending record without extending its grace period.
   *
   * Response 202: { status, requestedAt, scheduledFor, completedAt }
   */
  router.post(API_ROUTES.ACCOUNT_DELETE, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const rateCheck = state.accountDeletionRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.max(1, Math.ceil((rateCheck.resetAt - Date.now()) / 1000)),
      });
      return;
    }

    try {
      const { record, created } = await scheduleAccountDeletion(state, {
        userId: session.userId,
        graceMs,
      });
      if (created) {
        state.auditLog.record({
          event: 'account.deletion_requested',
          actor: session.userId,
          target: session.userId,
          outcome: 'success',
          details: { scheduledFor: record.scheduledFor },
        });
      }
      res.status(202).json(describeRecord(record));
    } catch (error) {
      console.error(`[account-deletion] request failed: ${describeError(error)}`);
      res.status(503).json({ error: 'account deletion unavailable' });
    }
  });

  /**
   * GET /account/delete
   *
   * Report whether an erasure is queued for this account.
   *
   * Response 200: { status, requestedAt, scheduledFor, completedAt } or
   * `{ status: 'none' }` when nothing is queued.
   */
  router.get(API_ROUTES.ACCOUNT_DELETE, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const record = getAccountDeletion(state, session.userId);
    res.status(200).json(record ? describeRecord(record) : { status: 'none' });
  });

  /**
   * DELETE /account/delete
   *
   * Cancel a queued erasure that has not run yet.
   *
   * Response 200: { status: 'cancelled' }, 404 when nothing was pending.
   */
  router.delete(API_ROUTES.ACCOUNT_DELETE, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    try {
      const cancelled = await cancelAccountDeletion(state, session.userId);
      if (!cancelled) {
        res.status(404).json({ error: 'no pending account deletion' });
        return;
      }
      state.auditLog.record({
        event: 'account.deletion_cancelled',
        actor: session.userId,
        target: session.userId,
        outcome: 'success',
        details: { scheduledFor: cancelled.scheduledFor },
      });
      res.status(200).json({ status: 'cancelled' });
    } catch (error) {
      console.error(`[account-deletion] cancellation failed: ${describeError(error)}`);
      res.status(503).json({ error: 'account deletion unavailable' });
    }
  });

  return router;
}

export { createAccountDeletionRouter };

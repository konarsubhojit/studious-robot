import express from 'express';
import { addBlock, removeBlock, listBlocksAsync } from '../security.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId } from '../lib/normalize.ts';
import { persistBlock, deletePersistedBlock } from '../lib/persistence.ts';
import { API_ROUTES } from '../../../shared/index.ts';
import type { Database } from '../../db/client.ts';

/**
 * Block management: block / unblock / list.
 */
function createBlocksRouter({ state, db }: { state: import('../stores/contracts.ts').ServerState; db: Database | null; }): import('express').Router {
  const router = express.Router();
  async function requireSession(req: express.Request, res: express.Response) {
    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) res.status(401).json({ error: 'invalid session' });
    return session;
  }

  /**
   * POST /blocks
   *
   * Block another user so they cannot initiate calls to you.
   * Idempotent: blocking an already-blocked user is a no-op.
   *
   * Body: { blockeeId: string }
   * Response 200: { blockerId, blockeeId }
   */
  router.post(API_ROUTES.BLOCKS, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const blockeeId = normaliseId(req.body?.blockeeId);
    if (!blockeeId) {
      res.status(400).json({ error: 'blockeeId is required' });
      return;
    }
    if (blockeeId === session.userId) {
      res.status(400).json({ error: 'cannot block yourself' });
      return;
    }

    try {
      if (state.blockState) await state.blockState.add(session.userId, blockeeId);
      else {
        if (state.stateAffinity === 'shared') throw new Error('shared block store unavailable');
        addBlock(state.blocks, session.userId, blockeeId);
        await persistBlock(db, session.userId, blockeeId);
      }
    } catch {
      res.status(503).json({ error: 'block store unavailable' });
      return;
    }
    state.auditLog.record({
      event: 'block.added',
      actor: session.userId,
      target: blockeeId,
      outcome: 'success',
    });

    console.log(`[security] block.added blockerId=${session.userId} blockeeId=${blockeeId}`);
    res.status(200).json({ blockerId: session.userId, blockeeId });
  });

  /**
   * DELETE /blocks/:blockeeId
   *
   * Remove a previously added block.
   *
   * Response 200: { blockerId, blockeeId }
   * Response 404: when the block did not exist
   */
  router.delete(`${API_ROUTES.BLOCKS}/:blockeeId`, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const blockeeId = normaliseId(req.params.blockeeId);
    if (!blockeeId) {
      res.status(400).json({ error: 'blockeeId is required' });
      return;
    }

    let removed: boolean;
    try {
      if (state.blockState) removed = await state.blockState.remove(session.userId, blockeeId);
      else {
        if (state.stateAffinity === 'shared') throw new Error('shared block store unavailable');
        removed = removeBlock(state.blocks, session.userId, blockeeId);
        if (removed) await deletePersistedBlock(db, session.userId, blockeeId);
      }
    } catch {
      res.status(503).json({ error: 'block store unavailable' });
      return;
    }
    if (!removed) {
      res.status(404).json({ error: 'block not found' });
      return;
    }

    state.auditLog.record({
      event: 'block.removed',
      actor: session.userId,
      target: blockeeId,
      outcome: 'success',
    });

    console.log(`[security] block.removed blockerId=${session.userId} blockeeId=${blockeeId}`);
    res.status(200).json({ blockerId: session.userId, blockeeId });
  });

  /**
   * GET /blocks
   *
   * Return the list of user IDs that the authenticated user has blocked.
   *
   * Response 200: { blockedUsers: string[] }
   */
  router.get(API_ROUTES.BLOCKS, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    try {
      res.status(200).json({ blockedUsers: await listBlocksAsync(state, session.userId) });
    } catch {
      res.status(503).json({ error: 'block store unavailable' });
    }
  });

  return router;
}

export { createBlocksRouter };

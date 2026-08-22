import express from 'express';
import { addBlock, removeBlock, listBlocks } from '../security.ts';
import { getSessionFromRequest } from '../lib/auth.ts';
import { normaliseId } from '../lib/normalize.ts';
import { persistBlock, deletePersistedBlock } from '../lib/persistence.ts';
import { API_ROUTES } from '../../../shared/index.ts';

/**
 * Block management: block / unblock / list.
 */
function createBlocksRouter({ state, db }: { state: import('../stores/contracts.ts').ServerState; db: any; }): import('express').Router {
  const router = express.Router();

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
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const blockeeId = normaliseId(req.body?.blockeeId);
    if (!blockeeId) {
      res.status(400).json({ error: 'blockeeId is required' });
      return;
    }
    if (blockeeId === session.userId) {
      res.status(400).json({ error: 'cannot block yourself' });
      return;
    }

    addBlock(state.blocks, session.userId, blockeeId);
    await persistBlock(db, session.userId, blockeeId);
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
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const blockeeId = normaliseId(req.params.blockeeId);
    if (!blockeeId) {
      res.status(400).json({ error: 'blockeeId is required' });
      return;
    }

    const removed = removeBlock(state.blocks, session.userId, blockeeId);
    if (!removed) {
      res.status(404).json({ error: 'block not found' });
      return;
    }

    await deletePersistedBlock(db, session.userId, blockeeId);

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
  router.get(API_ROUTES.BLOCKS, (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    res.status(200).json({ blockedUsers: listBlocks(state.blocks, session.userId) });
  });

  return router;
}

export { createBlocksRouter };

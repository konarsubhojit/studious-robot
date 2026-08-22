import { SHUTDOWN_DRAIN_POLL_MS } from '../config.ts';

/**
 * Wait until every connected Socket.IO client has disconnected, or until
 * `timeoutMs` elapses – whichever comes first.  Used during graceful shutdown
 * so in-flight connections get a chance to drain before being force-closed.
 */
async function waitForSocketsToDrain(io: import('socket.io').Server, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (io.engine?.clientsCount > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_POLL_MS));
  }
}

export { waitForSocketsToDrain };

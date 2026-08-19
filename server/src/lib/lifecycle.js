// @ts-check
'use strict';

const { SHUTDOWN_DRAIN_POLL_MS } = require('../config');

/**
 * Wait until every connected Socket.IO client has disconnected, or until
 * `timeoutMs` elapses – whichever comes first.  Used during graceful shutdown
 * so in-flight connections get a chance to drain before being force-closed.
 *
 * @param {import('socket.io').Server} io
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForSocketsToDrain(io, timeoutMs) {
  const start = Date.now();
  while (io.engine?.clientsCount > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_POLL_MS));
  }
}

module.exports = { waitForSocketsToDrain };

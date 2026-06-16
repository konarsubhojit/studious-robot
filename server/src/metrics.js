'use strict';

/**
 * Lightweight in-process metrics counters for basic observability.
 *
 * Exposed via the `/metrics` endpoint so operators can see live signaling
 * activity (connections, joins, relays) without pulling in a heavyweight
 * metrics dependency.
 */
function createMetrics() {
  const counters = {
    connectionsTotal: 0,
    disconnectionsTotal: 0,
    joinsTotal: 0,
    roomFullRejectionsTotal: 0,
    offersRelayedTotal: 0,
    answersRelayedTotal: 0,
    iceCandidatesRelayedTotal: 0,
    invalidPayloadsTotal: 0,
    turnCredentialsIssuedTotal: 0,
  };

  /**
   * Increment a named counter by an amount (default 1).
   *
   * @param {keyof typeof counters} name
   * @param {number} [amount=1]
   */
  function increment(name, amount = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) {
      counters[name] += amount;
    }
  }

  /**
   * @returns {Record<string, number>} A snapshot copy of all counters.
   */
  function snapshot() {
    return { ...counters };
  }

  return { increment, snapshot };
}

module.exports = { createMetrics };

'use strict';

/**
 * Lightweight, dependency-optional telemetry/error reporting.
 *
 * When `SENTRY_DSN` is configured this lazily loads `@sentry/node` (an optional
 * dependency) and reports captured errors there. When the DSN is unset — or the
 * package is not installed — it degrades to structured console logging so the
 * signaling server never hard-depends on a telemetry backend.
 *
 * Keeping this behind a tiny façade means the rest of the codebase calls
 * `telemetry.captureException(err)` without caring whether Sentry is present.
 *
 * @param {object} [options]
 * @param {string|null} [options.dsn] - Sentry DSN; telemetry is enabled when set.
 * @param {string} [options.environment]
 * @param {string} [options.instanceId]
 * @param {object} [options.logger=console]
 * @returns {{ enabled: boolean, captureException: Function, captureMessage: Function, flush: Function }}
 */
function createTelemetry({ dsn = null, environment = 'development', instanceId, logger = console } = {}) {
  let sentry = null;

  if (dsn) {
    try {
      // Optional dependency: only required when telemetry is actually enabled.
      // eslint-disable-next-line global-require
      sentry = require('@sentry/node');
      sentry.init({ dsn, environment, initialScope: { tags: { instanceId } } });
      logger.info?.(`[telemetry] Sentry enabled (environment=${environment}, instance=${instanceId})`);
    } catch (err) {
      sentry = null;
      logger.warn?.(`[telemetry] SENTRY_DSN set but @sentry/node unavailable; falling back to console: ${err.message}`);
    }
  }

  function captureException(error, context) {
    if (sentry) {
      sentry.captureException(error, context ? { extra: context } : undefined);
      return;
    }
    logger.error?.('[telemetry] exception', error?.stack || error, context || '');
  }

  function captureMessage(message, context) {
    if (sentry) {
      sentry.captureMessage(message, context ? { extra: context } : undefined);
      return;
    }
    logger.info?.('[telemetry] message', message, context || '');
  }

  async function flush(timeoutMs = 2000) {
    if (sentry?.flush) {
      try {
        await sentry.flush(timeoutMs);
      } catch {
        // Best-effort flush on shutdown.
      }
    }
  }

  return {
    enabled: Boolean(sentry),
    captureException,
    captureMessage,
    flush,
  };
}

module.exports = { createTelemetry };

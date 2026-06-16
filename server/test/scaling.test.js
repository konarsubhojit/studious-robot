'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTelemetry } = require('../src/telemetry.js');
const { attachRedisAdapter } = require('../src/redisAdapter.js');

function makeLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
  };
}

test('telemetry disabled without DSN logs to console', () => {
  const logger = makeLogger();
  const telemetry = createTelemetry({ logger });
  assert.equal(telemetry.enabled, false);

  const error = new Error('boom');
  telemetry.captureException(error, { foo: 'bar' });
  telemetry.captureMessage('hello');

  assert.equal(logger.calls.error.length, 1);
  assert.equal(logger.calls.info.length, 1);
});

test('telemetry with DSN but missing @sentry/node degrades to console', () => {
  const logger = makeLogger();
  // @sentry/node is an optional dependency and is not installed in CI, so
  // requiring it fails and telemetry must fall back rather than throw.
  const telemetry = createTelemetry({ dsn: 'https://example@sentry.invalid/1', logger });
  assert.equal(telemetry.enabled, false);
  assert.equal(logger.calls.warn.length, 1);
});

test('telemetry flush resolves even when disabled', async () => {
  const telemetry = createTelemetry({ logger: makeLogger() });
  await telemetry.flush();
});

test('attachRedisAdapter is a no-op without REDIS_URL', async () => {
  const logger = makeLogger();
  const io = { adapter: () => assert.fail('adapter should not be set') };
  const result = await attachRedisAdapter(io, { redisUrl: null, logger });
  assert.equal(result.enabled, false);
  await result.close();
});

test('attachRedisAdapter degrades when redis packages are unavailable', async () => {
  const logger = makeLogger();
  const io = { adapter: () => assert.fail('adapter should not be set') };
  // redis / @socket.io/redis-adapter are optional deps not installed in CI.
  const result = await attachRedisAdapter(io, { redisUrl: 'redis://localhost:6379', logger });
  assert.equal(result.enabled, false);
  assert.equal(logger.calls.warn.length, 1);
  await result.close();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, loadConfig, summarize, sweepDeliveryTimeouts } from './rig.mjs';

const baseEnv = { TARGET: 'https://example.test' };

test('loadConfig rejects odd user counts', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, USERS: '999' }),
    /USERS must be even/
  );
});

test('loadConfig derives ramp batch from users and ramp seconds', () => {
  const config = loadConfig({ ...baseEnv, USERS: '1000', RAMP_SECS: '120' });
  assert.equal(config.rampBatch, 9);
});

test('loadConfig rejects an explicit ramp batch that cannot finish in time', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, USERS: '1000', RAMP_SECS: '120', RAMP_BATCH: '8' }),
    /minimum required value is 9/
  );
});

test('loadConfig requires TARGET', () => {
  assert.throws(() => loadConfig({}), ConfigError);
});

test('sweepDeliveryTimeouts expires only old in-flight messages', () => {
  const inFlight = new Map([
    ['old', { t0: 1000, phase: 'steady' }],
    ['fresh', { t0: 4500, phase: 'steady' }],
  ]);
  const errors = {};

  assert.equal(sweepDeliveryTimeouts(inFlight, 7001, 5000, errors), 1);
  assert.deepEqual([...inFlight.keys()], ['fresh']);
  assert.deepEqual(errors, { delivery_timeout: 1 });
});

test('summarize reports empty and percentile buckets', () => {
  assert.deepEqual(summarize([]), { n: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  assert.deepEqual(summarize([100, 10, 50, 20]), { n: 4, p50: 20, p95: 100, p99: 100, max: 100 });
});

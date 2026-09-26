import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, createLatencyBucket, loadConfig, recordLatency, summarize, sweepDeliveryTimeouts } from './rig.mjs';

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

test('loadConfig defaults call generation off', () => {
  const config = loadConfig(baseEnv);

  assert.equal(config.callsPerMin, 0);
  assert.equal(config.callHoldSecs, 10);
  assert.equal(config.callAnswerRate, 100);
  assert.equal(config.maxInFlightCalls, 500);
});

test('loadConfig accepts call generation dials', () => {
  const config = loadConfig({
    ...baseEnv,
    USERS: '100',
    CALLS_PER_MIN: '12',
    CALL_HOLD_SECS: '3',
    CALL_ANSWER_RATE: '75',
  });

  assert.equal(config.callsPerMin, 12);
  assert.equal(config.callHoldSecs, 3);
  assert.equal(config.callAnswerRate, 75);
  assert.equal(config.maxInFlightCalls, 50);
});

test('loadConfig rejects invalid call generation dials', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, CALLS_PER_MIN: '-1' }),
    /CALLS_PER_MIN must be an integer >= 0/
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, CALL_HOLD_SECS: '-1' }),
    /CALL_HOLD_SECS must be an integer >= 0/
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, CALL_ANSWER_RATE: '101' }),
    /CALL_ANSWER_RATE must be an integer between 0 and 100/
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, CALL_ANSWER_RATE: '50.5' }),
    /CALL_ANSWER_RATE must be an integer >= 0/
  );
});

test('latency buckets retain a capped sample while reporting total observations', () => {
  const bucket = createLatencyBucket(3);

  for (const value of [10, 20, 30, 40, 50]) recordLatency(bucket, value);

  assert.equal(bucket.count, 5);
  assert.equal(bucket.samples.length, 3);
  assert.equal(summarize(bucket).n, 5);
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

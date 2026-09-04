import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSharedStateForMultiInstance,
  checkMultiInstanceState,
  hasSharedState,
  resolveInstanceId,
} from '../src/lib/instances.ts';

test('the instance ordinal is read from PM2, preferring NODE_APP_INSTANCE', () => {
  assert.equal(resolveInstanceId({ NODE_APP_INSTANCE: '3', pm_id: '9' }), 3);
  assert.equal(resolveInstanceId({ pm_id: '2' }), 2);
  assert.equal(resolveInstanceId({ PM2_INSTANCE_ID: '0' }), 0);
  assert.equal(resolveInstanceId({}), null);
  assert.equal(resolveInstanceId({ NODE_APP_INSTANCE: '', pm_id: 'nope' }), null);
});

test('shared state is only considered configured for a non-blank REDIS_URL', () => {
  assert.equal(hasSharedState({ REDIS_URL: 'redis://localhost:6379' }), true);
  assert.equal(hasSharedState({ REDIS_URL: '   ' }), false);
  assert.equal(hasSharedState({}), false);
});

test('a secondary instance without shared state is fatal in production', () => {
  const check = checkMultiInstanceState({ NODE_APP_INSTANCE: '4', NODE_ENV: 'production' });
  assert.equal(check.level, 'fatal');
  assert.equal(check.instanceId, 4);
  assert.equal(check.sharedState, false);
  assert.match(check.message, /REDIS_URL/);
});

test('the same situation outside production is only a warning', () => {
  assert.equal(checkMultiInstanceState({ NODE_APP_INSTANCE: '4' }).level, 'warn');
});

test('a lone instance, instance zero, or a Redis-backed fleet is fine', () => {
  assert.equal(checkMultiInstanceState({ NODE_ENV: 'production' }).level, 'ok');
  assert.equal(checkMultiInstanceState({ NODE_APP_INSTANCE: '0', NODE_ENV: 'production' }).level, 'ok');
  assert.equal(
    checkMultiInstanceState({
      NODE_APP_INSTANCE: '4',
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
    }).level,
    'ok'
  );
});

test('the assertion throws in production and warns elsewhere', () => {
  assert.throws(
    () => assertSharedStateForMultiInstance({ NODE_APP_INSTANCE: '1', NODE_ENV: 'production' }),
    /REDIS_URL is not set/
  );

  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const check = assertSharedStateForMultiInstance({ NODE_APP_INSTANCE: '1' });
    assert.equal(check.level, 'warn');
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /WARNING/);
});

test('a healthy configuration neither throws nor warns', () => {
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    assertSharedStateForMultiInstance({ NODE_APP_INSTANCE: '5', REDIS_URL: 'redis://localhost:6379' });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(lines, []);
});

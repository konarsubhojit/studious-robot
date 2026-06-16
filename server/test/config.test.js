'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, parsePositiveInt, resolveCorsOrigin } = require('../src/config.js');

test('loadConfig applies defaults for an empty environment', () => {
  const config = loadConfig({}, () => {});
  assert.equal(config.port, 4173);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.maxRoomSize, 2);
  assert.equal(config.corsOrigin, '*');
});

test('loadConfig reads overrides from the environment', () => {
  const config = loadConfig(
    { PORT: '8080', HOST: '127.0.0.1', MAX_ROOM_SIZE: '4', CORS_ORIGIN: 'https://a.com, https://b.com' },
    () => {},
  );
  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.maxRoomSize, 4);
  assert.deepEqual(config.corsOrigin, ['https://a.com', 'https://b.com']);
});

test('parsePositiveInt rejects non-positive integers', () => {
  assert.throws(() => parsePositiveInt('0', 1, 'X'), /Invalid X/);
  assert.throws(() => parsePositiveInt('-3', 1, 'X'), /Invalid X/);
  assert.throws(() => parsePositiveInt('abc', 1, 'X'), /Invalid X/);
  assert.equal(parsePositiveInt(undefined, 7, 'X'), 7);
  assert.equal(parsePositiveInt('', 7, 'X'), 7);
});

test('resolveCorsOrigin rejects browser origins in production when unset', () => {
  let warned = false;
  const origin = resolveCorsOrigin({ NODE_ENV: 'production' }, () => { warned = true; });
  assert.deepEqual(origin, []);
  assert.equal(warned, true);
});

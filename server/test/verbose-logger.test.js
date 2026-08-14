'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isVerboseLoggingEnabled, verboseLog } = require('../src/lib/verbose');

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('verbose logging is disabled by default and enabled by env', () => {
  withEnv({ VERBOSE_LOGGING: undefined, LOG_LEVEL: undefined }, () => {
    assert.equal(isVerboseLoggingEnabled(), false);
  });
  withEnv({ VERBOSE_LOGGING: 'true', LOG_LEVEL: undefined }, () => {
    assert.equal(isVerboseLoggingEnabled(), true);
  });
  withEnv({ VERBOSE_LOGGING: undefined, LOG_LEVEL: 'debug' }, () => {
    assert.equal(isVerboseLoggingEnabled(), true);
  });
});

test('verboseLog redacts sensitive metadata', () => {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    withEnv({ VERBOSE_LOGGING: 'true' }, () => {
      verboseLog('test', 'redaction', {
        pushToken: 'secret-token',
        nested: { authorization: 'bearer secret' },
      });
    });
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[verbose\]\[test\] redaction/);
  assert.match(lines[0], /\[REDACTED\]/);
  assert.doesNotMatch(lines[0], /secret-token|bearer secret/);
});

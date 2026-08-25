/**
 * The point of these helpers is the *non*-`Error` cases: the `pg`, `mongodb`,
 * `redis` and `firebase-admin` clients all reject with objects that carry a
 * `message` without being `Error` instances. The previous
 * `error instanceof Error ? error.message : …` idiom threw those away, which is
 * what these tests pin down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, describeError } from '../src/lib/errors.ts';

test('errorMessage reads the message off a real Error', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(new TypeError('bad type')), 'bad type');
});

test('errorMessage reads the message off a plain object thrown by a driver', () => {
  assert.equal(errorMessage({ code: 'ECONNREFUSED', message: 'connect refused' }), 'connect refused');
});

test('errorMessage accepts a thrown string', () => {
  assert.equal(errorMessage('just a string'), 'just a string');
});

test('errorMessage returns undefined when there is no usable message', () => {
  for (const value of [undefined, null, 42, '', {}, { message: '' }, { message: 404 }]) {
    assert.equal(errorMessage(value), undefined, `expected no message for ${JSON.stringify(value)}`);
  }
});

test('describeError prefers the message, whatever the value was thrown as', () => {
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError({ message: 'driver failure' }), 'driver failure');
});

test('describeError falls back to a stringified value when there is no message', () => {
  assert.equal(describeError(404), '404');
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
});

test('describeError survives a value whose own stringification throws', () => {
  const hostile = {
    get message() {
      return undefined;
    },
    toString() {
      throw new Error('nope');
    },
  };
  assert.equal(describeError(hostile), 'unknown error');
});

import { describeError, errorMessage } from '../src/errors';

/**
 * The point of these helpers is the *non*-`Error` cases: React Native's native
 * bridge and several linked modules reject with plain objects that carry a
 * `message`. The previous `error instanceof Error ? error.message : …` idiom
 * threw those away, which is what these tests pin down.
 */
describe('errorMessage', () => {
  test('reads the message off a real Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  test('reads the message off a plain object thrown by a native module', () => {
    expect(errorMessage({ code: 'E_PERM', message: 'permission denied' })).toBe(
      'permission denied',
    );
  });

  test('accepts a thrown string', () => {
    expect(errorMessage('just a string')).toBe('just a string');
  });

  test('returns undefined when there is no usable message', () => {
    expect(errorMessage(undefined)).toBeUndefined();
    expect(errorMessage(null)).toBeUndefined();
    expect(errorMessage(42)).toBeUndefined();
    expect(errorMessage('')).toBeUndefined();
    expect(errorMessage({})).toBeUndefined();
    expect(errorMessage({ message: '' })).toBeUndefined();
    expect(errorMessage({ message: 404 })).toBeUndefined();
  });
});

describe('describeError', () => {
  test('prefers the message, whatever the value was thrown as', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError({ message: 'native failure' })).toBe('native failure');
  });

  test('falls back to a stringified value when there is no message', () => {
    expect(describeError(404)).toBe('404');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });

  test('survives a value whose own stringification throws', () => {
    const hostile = {
      get message() {
        return undefined;
      },
      toString() {
        throw new Error('nope');
      },
    };
    expect(describeError(hostile)).toBe('unknown error');
  });
});

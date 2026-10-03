import { resolveDisplayName } from '../../shared/identity';

describe('resolveDisplayName', () => {
  test('prefers a trimmed display name', () => {
    expect(resolveDisplayName('alice', ' Alice Chen ')).toBe('Alice Chen');
  });

  test.each([undefined, null, '', '   '])('falls back to the user ID for %p', name => {
    expect(resolveDisplayName('alice', name)).toBe('alice');
  });
});

const VERIFICATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUP_LENGTH = 4;
const CODE_GROUP_COUNT = 2;

function fillRandomBytes(bytes) {
  if (!globalThis.crypto?.getRandomValues) {
    // Verification codes gate identity ownership, so a weak fallback would be
    // a real security risk. Fail closed instead of silently generating a
    // predictable code with `Math.random()`.
    throw new Error('Secure random number generator unavailable');
  }

  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function normalizeVerificationCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

export function generateVerificationCode() {
  const totalCharacters = CODE_GROUP_LENGTH * CODE_GROUP_COUNT;
  const bytes = fillRandomBytes(new Uint8Array(totalCharacters));
  const characters = Array.from(
    bytes,
    byte => VERIFICATION_CODE_ALPHABET[byte % VERIFICATION_CODE_ALPHABET.length],
  );

  return Array.from({ length: CODE_GROUP_COUNT }, (_, groupIndex) => {
    const start = groupIndex * CODE_GROUP_LENGTH;
    return characters.slice(start, start + CODE_GROUP_LENGTH).join('');
  }).join('-');
}

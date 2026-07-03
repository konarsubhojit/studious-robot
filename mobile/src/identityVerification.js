const VERIFICATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUP_LENGTH = 4;
const CODE_GROUP_COUNT = 2;

function fillRandomBytes(bytes) {
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  // React Native should normally expose a crypto API, but keep a small fallback
  // so older test/runtime environments can still generate a code. This path is
  // less secure and should only be used when no stronger primitive exists.
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
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
    (byte) => VERIFICATION_CODE_ALPHABET[byte % VERIFICATION_CODE_ALPHABET.length],
  );

  return Array.from({ length: CODE_GROUP_COUNT }, (_, groupIndex) => {
    const start = groupIndex * CODE_GROUP_LENGTH;
    return characters.slice(start, start + CODE_GROUP_LENGTH).join('');
  }).join('-');
}

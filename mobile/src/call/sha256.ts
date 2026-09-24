/* eslint-disable no-bitwise */
// SHA-256 is specified in terms of 32-bit rotations, shifts and xors; written
// any other way it would not be SHA-256.

/**
 * A dependency-free SHA-256, used to derive the call verification code in
 * `./sas`.
 *
 * React Native ships no `crypto.subtle`, and the app deliberately carries no
 * crypto dependency (see `docs/e2ee-design.md`), so the one hash the short
 * authentication string needs is implemented here. It is a plain FIPS 180-4
 * implementation over short ASCII inputs — DTLS fingerprints — and is not
 * intended as a general-purpose hashing utility.
 */

/** Round constants: the first 32 bits of the cube roots of the first 64 primes. */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Initial hash values: the first 32 bits of the square roots of the first 8 primes. */
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** Right rotation of a 32-bit word. */
function rotr(word: number, bits: number): number {
  return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

/** UTF-8 bytes of `text`, without depending on `TextEncoder`. */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** The message with its `1` bit, zero padding and 64-bit big-endian length. */
function padMessage(bytes: number[]): number[] {
  const bitLength = bytes.length * 8;
  const padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  // Lengths here are a few dozen bytes, so the high word is always zero; it is
  // written explicitly rather than assumed.
  const highBits = Math.floor(bitLength / 0x100000000);
  for (const shift of [24, 16, 8, 0]) padded.push((highBits >>> shift) & 0xff);
  for (const shift of [24, 16, 8, 0]) padded.push((bitLength >>> shift) & 0xff);
  return padded;
}

/** Compress one 64-byte block into `hash`, in place. */
function compressBlock(hash: number[], padded: number[], blockStart: number): void {
  const w = new Array(64).fill(0) as number[];
  for (let i = 0; i < 16; i += 1) {
    const offset = blockStart + i * 4;
    w[i] =
      ((padded[offset] << 24) |
        (padded[offset + 1] << 16) |
        (padded[offset + 2] << 8) |
        padded[offset + 3]) >>>
      0;
  }
  for (let i = 16; i < 64; i += 1) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }

  let [a, b, c, d, e, f, g, h] = hash;
  for (let i = 0; i < 64; i += 1) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (s0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  const round = [a, b, c, d, e, f, g, h];
  for (let i = 0; i < 8; i += 1) hash[i] = (hash[i] + round[i]) >>> 0;
}

/**
 * SHA-256 of `text`, as the 32 digest bytes.
 *
 * @param text - Message to hash; encoded as UTF-8.
 */
export function sha256Bytes(text: string): number[] {
  const hash = H0.slice();
  const padded = padMessage(utf8Bytes(text));
  for (let blockStart = 0; blockStart < padded.length; blockStart += 64) {
    compressBlock(hash, padded, blockStart);
  }
  const digest: number[] = [];
  for (const word of hash) {
    for (const shift of [24, 16, 8, 0]) digest.push((word >>> shift) & 0xff);
  }
  return digest;
}

/**
 * SHA-256 of `text`, lower-case hex.
 *
 * @param text - Message to hash; encoded as UTF-8.
 */
export function sha256Hex(text: string): string {
  return sha256Bytes(text)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

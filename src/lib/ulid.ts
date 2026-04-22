// Implements REQ-GEN-006
// ULID generator — 26-char Crockford base32, lexicographically sortable by time.
// Layout: 48-bit ms timestamp (10 chars) + 80-bit randomness (16 chars).
// Web-standard crypto only — Workers runtime compatible, no Node imports.

// Crockford base32 alphabet: excludes I, L, O, U to avoid ambiguity.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_BYTES = 10; // 80 bits

/**
 * Generate a ULID — a 26-character Crockford base32 identifier that sorts
 * lexicographically by creation time.
 */
export function generateUlid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

/**
 * Encode a millisecond timestamp as 10 Crockford base32 characters (48 bits).
 * Most-significant character first so lexicographic sort matches time order.
 */
function encodeTime(ms: number): string {
  let remaining = ms;
  const chars: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const index = remaining % 32;
    // Bracket-access on a const string literal is always defined; the
    // `?? ''` silences noUncheckedIndexedAccess without runtime cost.
    chars[i] = CROCKFORD_ALPHABET[index] ?? '';
    remaining = Math.floor(remaining / 32);
  }
  return chars.join('');
}

/**
 * Encode 80 bits of cryptographic randomness as 16 Crockford base32 characters.
 * Maps each 5-bit group (16 groups total) to one alphabet character.
 */
function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(bytes);

  // Walk the bit stream MSB-first, consuming 5 bits per output character.
  const chars: string[] = new Array(RANDOM_LEN);
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let byteIndex = 0;
  let outIndex = 0;

  while (outIndex < RANDOM_LEN) {
    if (bitsInBuffer < 5) {
      // `byteIndex` stays strictly within [0, RANDOM_BYTES) by construction
      // (16 chars * 5 bits = 80 bits = 10 bytes), but noUncheckedIndexedAccess
      // still requires a guard — fall back to 0 which is unreachable.
      const nextByte = bytes[byteIndex] ?? 0;
      bitBuffer = (bitBuffer << 8) | nextByte;
      bitsInBuffer += 8;
      byteIndex++;
    }
    bitsInBuffer -= 5;
    const fiveBits = (bitBuffer >> bitsInBuffer) & 0x1f;
    chars[outIndex] = CROCKFORD_ALPHABET[fiveBits] ?? '';
    outIndex++;
    // Clear the consumed bits so they don't pollute the next window.
    bitBuffer &= (1 << bitsInBuffer) - 1;
  }

  return chars.join('');
}

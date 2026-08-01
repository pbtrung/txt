// Crockford base32 (crockford.com/base32.html): 32-char alphabet excluding
// the visually-ambiguous I/L/O/U, no padding. Only encoding is needed here --
// raw_path values (docs/data_model.md) are opaque identifiers, never decoded
// back into their original random bytes.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function crockfordBase32Lowercase(bytes: Uint8Array): string {
  // bitBuffer only ever holds the not-yet-consumed low `bitCount` bits
  // (masked off after each drain) -- never lets it grow past ~12 bits, so
  // this stays well within JS's 32-bit bitwise-operator range regardless of
  // input length.
  let bitBuffer = 0;
  let bitCount = 0;
  let out = "";
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ALPHABET[(bitBuffer >>> bitCount) & 0x1f];
    }
    bitBuffer &= (1 << bitCount) - 1;
  }
  if (bitCount > 0) out += ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
  return out;
}

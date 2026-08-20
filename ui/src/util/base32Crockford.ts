// Ports txt/random_token.py's to_base32_crockford exactly: 32 random bytes
// render as 52 lowercase base32-Crockford characters for db_path, db_prefix,
// and every other R2 object-key component (docs/storage_layout.md §1).
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function toBase32Crockford(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

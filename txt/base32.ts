// Crockford base32 (lowercase, excludes i/l/o/u), fixed-length encoding of
// 32 random bytes -- used as a fresh R2/S3 object key per migrated part.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const RANDOM_BYTES = 32;
const OUTPUT_CHARS = Math.ceil((RANDOM_BYTES * 8) / 5); // 52

export function randomPath(): string {
  let bits = 0n;
  for (const b of randomBytes(RANDOM_BYTES)) bits = (bits << 8n) | BigInt(b);
  bits <<= BigInt(OUTPUT_CHARS * 5 - RANDOM_BYTES * 8);
  let out = "";
  for (let i = OUTPUT_CHARS - 1; i >= 0; i--)
    out += ALPHABET[Number((bits >> BigInt(i * 5)) & 0x1fn)];
  return out;
}

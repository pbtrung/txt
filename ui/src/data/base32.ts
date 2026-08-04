// Crockford's human-readable Base32 (excludes i, l, o, u -- visually
// ambiguous with 1/1/0/v; no padding). Mirrors txt/base32.ts's
// crockfordBase32Lowercase exactly, used the same way: randomToken.ts's
// prefix/raw_key generation (docs/data_model.md's txt.prefix/txtParts.path).

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function encode(data: Uint8Array): string {
  if (data.length === 0) return "";
  const totalBits = data.length * 8;
  const numSymbols = Math.ceil(totalBits / 5);
  const padBits = numSymbols * 5 - totalBits;

  let bits = 0n;
  for (const byte of data) {
    bits = (bits << 8n) | BigInt(byte);
  }
  bits <<= BigInt(padBits);

  let out = "";
  for (let i = 0; i < numSymbols; i++) {
    const shift = BigInt(5 * (numSymbols - 1 - i));
    out += ALPHABET[Number((bits >> shift) & 0x1fn)];
  }
  return out;
}

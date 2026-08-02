// Decodes one txt part's stored content into text, for Reader pagination.
// txt_parts.content (owner.ts's partContent) is brotli-compressed raw text
// and nothing else now -- protected only by SQLCipher's own page-level
// encryption, no separate per-part key/R2 round-trip/AEAD unwrap the way
// the old per-part-R2-addressed version needed (see owner.ts's own comment).

import * as brotli from "../crypto/brotli";

export async function decodePart(content: Uint8Array): Promise<string> {
  const cleaned = await brotli.decompress(content);
  return new TextDecoder().decode(cleaned);
}

// Decrypts a compressed JSON blob and parses it -- the shape owner.ts
// (r2_config), metadata.ts (txt_metadata.content), and perUserBlob.ts
// (txt_access/bookmarks) each store their payload in (see docs/crypto.md's
// Blob format: compressed:true for structured payloads).

import * as blob from "../crypto/blob";

export async function decryptJson(key: Uint8Array, encrypted: Uint8Array): Promise<unknown> {
  const decrypted = await blob.decrypt(key, encrypted, true);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

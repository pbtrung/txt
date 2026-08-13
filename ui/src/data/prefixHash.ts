// Plain commitment stored as sharedTxt.prefixHash (and, mirrored the same
// way, txt.prefixHash). Browser port of txt/prefixHash.ts -- ui/ only ever
// mints a fresh prefix when creating a share (adminShares.ts's grantShare),
// but computes this the same SHA-256(UTF-8(prefix)) -> Base64 way the
// Worker itself re-derives to verify a client-supplied prefix.

import { bytesToBase64 } from "../crypto/bytes";

export async function computePrefixHash(prefix: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(prefix),
  );
  return bytesToBase64(new Uint8Array(digest));
}

// Fetches and decrypts the account's active bundle object -- not
// brotli-compressed, unlike the library index (txt/bundle.py's
// BundleBuilder.build encrypts the raw header+map+pages+index directly).
// Parsing that plaintext into its header/map/hot-pages/index sections is
// Step 9's job (Reader opening BB); this just gets the plaintext bytes.
import { decrypt } from "../crypto/cryptoBlob";
import type { R2 } from "./r2";
import type { Aa } from "./session";
import { readActiveBundleKeys } from "./session";

export async function loadBundle(aa: Aa, umk: Uint8Array, dbPrefix: string, r2: R2): Promise<Uint8Array | null> {
  const keys = await readActiveBundleKeys(aa, umk);
  if (!keys) return null;
  const encrypted = await r2.getObject(`${dbPrefix}/b/${keys.bundleKey}`);
  return decrypt(encrypted, keys.bundleEncKey);
}

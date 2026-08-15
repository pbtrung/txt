// Unwraps the Worker's /v1/keys response (docs/auth.md §4.1/§5 step 3):
// decrypt umk with user_root_key, then decrypt cred_store.content with umk
// to recover display_name/db_master_key/db_path/db_prefix. The Worker never
// sees any of this in plaintext -- both decrypt steps happen here.
import { decrypt, decryptJson } from "../crypto/cryptoBlob";
import { fromBase64 } from "../util/base64";
import type { KeysResponse } from "./workerClient";

export interface CredStorePayload {
  display_name: string;
  db_master_key: string; // base64
  db_path: string;
  db_prefix: string;
}

export interface UnwrappedSession {
  umk: Uint8Array;
  credStore: CredStorePayload;
}

export async function unwrapKeys(
  keys: KeysResponse,
  userRootKeyBase64: string,
): Promise<UnwrappedSession> {
  const ikm = fromBase64(userRootKeyBase64);
  const umk = await decrypt(fromBase64(keys.umk), ikm);
  const credStore = await decryptJson<CredStorePayload>(
    fromBase64(keys.credStore),
    umk,
  );
  return { umk, credStore };
}

// Unwraps the Worker's /v1/keys response (docs/auth.md §4.1/§5 step 3):
// decrypt umk with user_root_key, then decrypt cred_store.content with umk
// to recover user_handle/display_name/db_master_key/db_path/db_prefix. The Worker never
// sees any of this in plaintext -- both decrypt steps happen here.
import { decrypt, decryptJson } from "../crypto/cryptoBlob";
import { fromBase64, toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";
import type { KeysResponse } from "./workerClient";
import type { R2SigningIdentity } from "./workerClient";

interface CredStorePayload {
  display_name: string;
  user_handle: string; // base64, 32 bytes
  db_master_key: string; // base64
  db_path: string;
  db_prefix: string;
}

interface UnwrappedSession {
  umk: Uint8Array;
  credStore: CredStorePayload;
  signing: R2SigningIdentity;
}

export async function unwrapKeys(
  keys: KeysResponse,
  userRootKeyBase64: string,
): Promise<UnwrappedSession> {
  const ikm = fromBase64(userRootKeyBase64);
  const umk = await decrypt(fromBase64(keys.umk), ikm);
  const payload = await decryptJson<unknown>(fromBase64(keys.credStore), umk);
  const credStore = parseCredStore(payload);
  const userHandle = parseUserHandle(credStore.user_handle);
  const privateDer = await decrypt(fromBase64(keys.signing.privateKey), umk);
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(privateDer),
      { name: "ECDSA", namedCurve: "P-521" },
      false,
      ["sign"],
    );
    return {
      umk,
      credStore,
      signing: { ticket: keys.r2Ticket, userHandle, privateKey },
    };
  } finally {
    privateDer.fill(0);
  }
}

function parseCredStore(value: unknown): CredStorePayload {
  const data = objectRecord(value, "credential store");
  return {
    display_name: stringField(data, "display_name", "credential store"),
    user_handle: stringField(data, "user_handle", "credential store"),
    db_master_key: stringField(data, "db_master_key", "credential store"),
    db_path: stringField(data, "db_path", "credential store"),
    db_prefix: stringField(data, "db_prefix", "credential store"),
  };
}

function parseUserHandle(value: string): Uint8Array {
  const bytes = fromBase64(value);
  if (bytes.byteLength !== 32 || toBase64(bytes) !== value) {
    throw new Error("credential store user_handle must be 32 bytes in base64");
  }
  return bytes;
}

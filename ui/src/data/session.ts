// docs/auth.md §5 step 3: unwraps the owner's key material entirely
// client-side once GET /v1/owner has returned it. The Worker never sees
// umk, the credential payload, or an unwrapped private key.
import { decrypt, decryptJson } from "../crypto/cryptoBlob";
import { fromBase64, toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";
import type { OwnerRecord } from "./apiClient";
import type { OwnerSigningIdentity } from "./ownerProof";

const USER_HANDLE_BYTES = 32;

interface CredentialPayload {
  user_handle: string; // base64, 32 bytes
  display_name: string;
  db_prefix: string;
}

interface UnwrappedOwner {
  umk: Uint8Array;
  displayName: string;
  dbPrefix: string;
  signing: OwnerSigningIdentity;
}

export async function unwrapOwner(
  owner: OwnerRecord,
  userRootKeyBase64: string,
): Promise<UnwrappedOwner> {
  const ikm = fromBase64(userRootKeyBase64);
  const umk = await decrypt(owner.wrappedUmk, ikm);
  const credentials = parseCredentialPayload(
    await decryptJson<unknown>(owner.encryptedCredentials, umk),
  );
  const userHandle = parseUserHandle(credentials.user_handle);
  const signingPrivateKey = await importSigningKey(owner.wrappedSignPrivateKey, umk);
  // docs/crypto.md's Composite KEM support: owner.wrappedKemPrivateKey is
  // deliberately left wrapped here -- nothing in this app currently
  // encapsulates or decapsulates with it, so there's no reason to hold
  // decrypted KEM private key material in memory until something does.
  return {
    umk,
    displayName: credentials.display_name,
    dbPrefix: credentials.db_prefix,
    signing: { ticket: owner.ticket, userHandle, privateKey: signingPrivateKey },
  };
}

async function importSigningKey(
  wrapped: Uint8Array,
  umk: Uint8Array,
): Promise<CryptoKey> {
  const privateDer = await decrypt(wrapped, umk);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(privateDer),
      { name: "ECDSA", namedCurve: "P-521" },
      false,
      ["sign"],
    );
  } finally {
    privateDer.fill(0);
  }
}

function parseCredentialPayload(value: unknown): CredentialPayload {
  const data = objectRecord(value, "credential payload");
  return {
    user_handle: stringField(data, "user_handle", "credential payload"),
    display_name: stringField(data, "display_name", "credential payload"),
    db_prefix: stringField(data, "db_prefix", "credential payload"),
  };
}

function parseUserHandle(value: string): Uint8Array {
  const bytes = fromBase64(value);
  if (bytes.byteLength !== USER_HANDLE_BYTES || toBase64(bytes) !== value) {
    throw new Error(
      `credential payload user_handle must be ${USER_HANDLE_BYTES} bytes in base64`,
    );
  }
  return bytes;
}

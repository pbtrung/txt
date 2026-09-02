// docs/crypto.md §"Share grant envelope": how the exact R2 object path
// travels from the Worker to a share URL and back, without D1 ever storing
// it (docs/sharing.md §1). Only the Worker, holding SHARE_GRANT_KEY, can
// produce or open a grant -- this is genuinely Worker-side crypto, unlike
// the Blob Format (ui/src/crypto/), which the Worker never needs: the
// Worker holds SHARE_GRANT_KEY itself, so it's the only party able to do
// anything with a grant either way.
const VERSION = 0x01;
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MIN_LEN = 1 + SALT_LEN + NONCE_LEN + TAG_LEN; // 61

const KEY_INFO_PREFIX = new TextEncoder().encode("txt:share-grant-key:v1");
const AD_PREFIX = new TextEncoder().encode("txt:share-grant:v1");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Binds the derived key (via HKDF's `info`) and the AEAD additional data to
// this specific share's `idHash` -- decrypting under a different share's
// idHash fails the tag check, so a grant can't be replayed against another
// share (docs/crypto.md).
async function deriveKey(
  shareGrantKey: Uint8Array,
  salt: Uint8Array,
  idHash: Uint8Array,
): Promise<CryptoKey> {
  const ikmKey = await crypto.subtle.importKey("raw", shareGrantKey, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: concat(KEY_INFO_PREFIX, idHash) },
    ikmKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals `objectPath` into a grant envelope (docs/crypto.md), given the
 * share's `idHash = SHA-256(raw share_id)` and the Worker's
 * `shareGrantKey`. Returns the raw envelope bytes -- base64url-encoding
 * for transport is the caller's job. */
export async function sealGrant(
  objectPath: string,
  idHash: Uint8Array,
  shareGrantKey: Uint8Array,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const key = await deriveKey(shareGrantKey, salt, idHash);
  const ad = concat(AD_PREFIX, idHash);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: TAG_LEN * 8 },
      key,
      new TextEncoder().encode(objectPath),
    ),
  );
  return concat(new Uint8Array([VERSION]), salt, nonce, sealed);
}

/** Opens a grant envelope, given the same `idHash` and `shareGrantKey` used
 * to seal it. Throws if the envelope is malformed, the version is
 * unsupported, or the AEAD tag doesn't verify (including when `idHash`
 * doesn't match the one the grant was sealed for). */
export async function openGrant(
  envelope: Uint8Array,
  idHash: Uint8Array,
  shareGrantKey: Uint8Array,
): Promise<string> {
  if (envelope.length < MIN_LEN) {
    throw new Error(`grant too short: ${envelope.length} < ${MIN_LEN}`);
  }
  if (envelope[0] !== VERSION) {
    throw new Error(`unsupported grant version: ${envelope[0]}`);
  }
  const saltStart = 1;
  const nonceStart = saltStart + SALT_LEN;
  const sealedStart = nonceStart + NONCE_LEN;
  const salt = envelope.slice(saltStart, nonceStart);
  const nonce = envelope.slice(nonceStart, sealedStart);
  const sealed = envelope.slice(sealedStart);
  const key = await deriveKey(shareGrantKey, salt, idHash);
  const ad = concat(AD_PREFIX, idHash);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: TAG_LEN * 8 },
      key,
      sealed,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // crypto.subtle.decrypt's own error carries no detail (by design, to
    // avoid oracle attacks); reject uniformly rather than let a raw
    // OperationError leak through with a misleading stack.
    throw new Error("grant AEAD tag verification failed");
  }
}

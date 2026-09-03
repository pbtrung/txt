import { describe, expect, it } from "vitest";

import { encrypt, encryptJson } from "../../src/crypto/cryptoBlob";
import type { OwnerRecord } from "../../src/data/apiClient";
import { unwrapOwner } from "../../src/data/session";
import { toBase64 } from "../../src/util/base64";

async function wrappedOwner(
  userRootKey: Uint8Array,
  umk: Uint8Array,
  payload: unknown,
): Promise<{ owner: OwnerRecord; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateDer = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    publicKey: pair.publicKey,
    owner: {
      wrappedUmk: await encrypt(umk, userRootKey),
      signPublicKey: new Uint8Array(
        await crypto.subtle.exportKey("spki", pair.publicKey),
      ),
      wrappedSignPrivateKey: await encrypt(privateDer, umk),
      kemPublicKey: crypto.getRandomValues(new Uint8Array(1624)),
      // unwrapOwner() deliberately never decrypts this (session.ts) -- any
      // bytes are fine here, it just needs to be present on the shape.
      wrappedKemPrivateKey: crypto.getRandomValues(new Uint8Array(3224)),
      encryptedCredentials: await encryptJson(payload, umk),
      ticket: "header.payload.signature",
    },
  };
}

describe("unwrapOwner (real crypto)", () => {
  it("unwraps the credential payload and imports a non-extractable P-521 key", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const payload = {
      display_name: "Ada",
      user_handle: toBase64(new Uint8Array(32).fill(7)),
      db_prefix: "b".repeat(52),
    };
    const { owner, publicKey } = await wrappedOwner(userRootKey, umk, payload);

    const result = await unwrapOwner(owner, toBase64(userRootKey));

    expect([...result.umk]).toEqual([...umk]);
    expect(result.displayName).toBe(payload.display_name);
    expect(result.dbPrefix).toBe(payload.db_prefix);
    expect(result.signing.ticket).toBe("header.payload.signature");
    expect(result.signing.userHandle).toEqual(new Uint8Array(32).fill(7));
    expect(result.signing.privateKey.extractable).toBe(false);
    const message = new TextEncoder().encode("proof");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-512" },
      result.signing.privateKey,
      message,
    );
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-512" },
        publicKey,
        signature,
        message,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a umk wrapped under the wrong user_root_key", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const wrongKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const { owner } = await wrappedOwner(userRootKey, umk, {});

    await expect(unwrapOwner(owner, toBase64(wrongKey))).rejects.toThrow();
  });

  it("rejects an incomplete decrypted credential payload", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const { owner } = await wrappedOwner(userRootKey, umk, {
      display_name: "Ada",
      user_handle: toBase64(new Uint8Array(32)),
    });

    await expect(unwrapOwner(owner, toBase64(userRootKey))).rejects.toThrow(
      /db_prefix/,
    );
  });

  it("rejects a decrypted user handle with the wrong size", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const payload = {
      display_name: "Ada",
      user_handle: toBase64(new Uint8Array(31)),
      db_prefix: "b".repeat(52),
    };
    const { owner } = await wrappedOwner(userRootKey, umk, payload);
    await expect(unwrapOwner(owner, toBase64(userRootKey))).rejects.toThrow(
      /user_handle must be 32 bytes/,
    );
  });
});

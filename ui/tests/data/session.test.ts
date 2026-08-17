import { describe, expect, it } from "vitest";

import { encrypt, encryptJson } from "../../src/crypto/cryptoBlob";
import { unwrapKeys } from "../../src/data/session";
import type { KeysResponse } from "../../src/data/workerClient";
import { toBase64 } from "../../src/util/base64";

async function wrappedKeys(
  userRootKey: Uint8Array,
  umk: Uint8Array,
  payload: unknown,
): Promise<{ keys: KeysResponse; publicKey: CryptoKey }> {
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
    keys: {
      uid: "uid-123",
      umk: toBase64(await encrypt(umk, userRootKey)),
      signing: {
        version: 1,
        algorithm: "ECDSA-P521-SHA512",
        privateKey: toBase64(await encrypt(privateDer, umk)),
      },
      credStore: toBase64(await encryptJson(payload, umk)),
    },
  };
}

describe("unwrapKeys (real crypto)", () => {
  it("unwraps the credential store and imports a non-extractable P-521 key", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const payload = {
      display_name: "Ada",
      db_master_key: toBase64(crypto.getRandomValues(new Uint8Array(256))),
      db_path: "a".repeat(52),
      db_prefix: "b".repeat(52),
    };
    const { keys, publicKey } = await wrappedKeys(userRootKey, umk, payload);

    const result = await unwrapKeys(keys, toBase64(userRootKey));

    expect([...result.umk]).toEqual([...umk]);
    expect(result.credStore).toEqual(payload);
    expect(result.signing.uid).toBe("uid-123");
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
    const { keys } = await wrappedKeys(userRootKey, umk, {});

    await expect(unwrapKeys(keys, toBase64(wrongKey))).rejects.toThrow();
  });

  it("rejects an incomplete decrypted credential store", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const { keys } = await wrappedKeys(userRootKey, umk, { display_name: "Ada" });

    await expect(unwrapKeys(keys, toBase64(userRootKey))).rejects.toThrow(
      /db_master_key/,
    );
  });
});

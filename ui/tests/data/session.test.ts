import { describe, expect, it } from "vitest";
import { encrypt, encryptJson } from "../../src/crypto/cryptoBlob";
import { toBase64 } from "../../src/util/base64";
import type { KeysResponse } from "../../src/data/workerClient";
import { unwrapKeys } from "../../src/data/session";

describe("unwrapKeys (real sqlcipher.wasm)", () => {
  it("unwraps umk with user_root_key, then cred_store with umk", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));
    const payload = {
      display_name: "Ada",
      db_master_key: toBase64(crypto.getRandomValues(new Uint8Array(256))),
      db_path: "a".repeat(52),
      db_prefix: "b".repeat(52),
    };

    const keys: KeysResponse = {
      type: "user",
      umk: toBase64(await encrypt(umk, userRootKey)),
      credStore: toBase64(await encryptJson(payload, umk)),
    };

    const result = await unwrapKeys(keys, toBase64(userRootKey));

    expect([...result.umk]).toEqual([...umk]);
    expect(result.credStore).toEqual(payload);
  });

  it("rejects a umk wrapped under the wrong user_root_key", async () => {
    const userRootKey = crypto.getRandomValues(new Uint8Array(256));
    const wrongKey = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(128));

    const keys: KeysResponse = {
      type: "user",
      umk: toBase64(await encrypt(umk, userRootKey)),
      credStore: toBase64(await encryptJson({}, umk)),
    };

    await expect(unwrapKeys(keys, toBase64(wrongKey))).rejects.toThrow();
  });
});

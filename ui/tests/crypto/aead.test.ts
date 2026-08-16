import { describe, expect, it } from "vitest";
import { aeadDecrypt, aeadEncrypt, hkdfSha3_512 } from "../../src/crypto/aead";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function filled(length: number, seed: number): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_, i) => (i * seed) & 0xff));
}

describe("aead (real sqlcipher.wasm)", () => {
  it("round-trips plaintext through encrypt then decrypt", async () => {
    const key = filled(64, 7);
    const nonce = filled(64, 3);
    const aad = new TextEncoder().encode("aead-test-aad");
    const plaintext = new TextEncoder().encode("hello from the browser crypto layer");

    const { ciphertext, tag } = await aeadEncrypt(key, nonce, aad, plaintext);
    const decrypted = await aeadDecrypt(key, nonce, aad, ciphertext, tag);

    expect(new TextDecoder().decode(decrypted)).toBe(
      "hello from the browser crypto layer",
    );
  });

  it("rejects a tampered ciphertext byte", async () => {
    const key = filled(64, 11);
    const nonce = filled(64, 5);
    const aad = bytes(1, 2, 3);
    const plaintext = new TextEncoder().encode("tamper me");

    const { ciphertext, tag } = await aeadEncrypt(key, nonce, aad, plaintext);
    const tampered = ciphertext.slice();
    tampered[0] ^= 0xff;

    await expect(aeadDecrypt(key, nonce, aad, tampered, tag)).rejects.toThrow();
  });

  it("derives deterministic HKDF-SHA3-512 output", async () => {
    const ikm = filled(300, 5);
    const salt = filled(64, 1);
    const info = new TextEncoder().encode("ui-test-info");

    const out1 = await hkdfSha3_512(ikm, salt, info, 64);
    const out2 = await hkdfSha3_512(ikm, salt, info, 64);

    expect([...out1]).toEqual([...out2]);
    expect(out1.some((b) => b !== 0)).toBe(true);
  });

  it("rejects invalid AEAD buffer sizes before entering wasm", async () => {
    const valid = filled(64, 1);

    await expect(aeadEncrypt(filled(63, 1), valid, bytes(), bytes())).rejects.toThrow(
      /key.*64 bytes/,
    );
    await expect(aeadEncrypt(valid, filled(63, 1), bytes(), bytes())).rejects.toThrow(
      /nonce.*64 bytes/,
    );
    await expect(
      aeadDecrypt(valid, valid, bytes(), bytes(), filled(63, 1)),
    ).rejects.toThrow(/tag.*64 bytes/);
  });

  it("rejects invalid HKDF output lengths", async () => {
    await expect(hkdfSha3_512(bytes(), bytes(), bytes(), -1)).rejects.toThrow(
      /non-negative/,
    );
  });
});

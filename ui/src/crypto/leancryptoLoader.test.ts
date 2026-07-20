import { describe, expect, it } from "vitest";

import { aeadDecrypt, aeadEncrypt, hkdf, hmacSha3_256, pbkdf2Sha3_256 } from "./leancryptoLoader";
import { bytesToHex, hexToBytes } from "./testUtil";

// Known-good vectors cross-checked by hand against the real native
// leancrypto library (via txt/leancrypto.py's ctypes bindings) -- see
// docs/ui.md's implementation plan. These pin that cross-check down as a
// permanent regression test.

describe("leancryptoLoader", () => {
  it("HKDF-SHA3-512 matches the native leancrypto output", async () => {
    const ikm = Uint8Array.from({ length: 64 }, (_, i) => i);
    const salt = Uint8Array.from({ length: 64 }, (_, i) => i + 64);
    const out = await hkdf(ikm, salt, 128);
    expect(bytesToHex(out)).toBe(
      "79dd56727a360e40c4561bd6f893e378479d84b698de1d0bd6b0590572e36780cdcdd74a9f6693aaed1461ef858d38c" +
        "da7ae4b32fa48294bfe2c120705283eb90857b02c1507e3b581338e9984405a67292fbd11608f2ceeab3a962584248c" +
        "ffdd35cad3abfb1ab55b75733ae6d37467e73feca916893daceed6ec1fcdcf2b8e",
    );
  });

  it("HMAC-SHA3-256 matches the native leancrypto output", async () => {
    const key = new TextEncoder().encode("k".repeat(16));
    const data = new TextEncoder().encode("hello world");
    const out = await hmacSha3_256(key, data);
    expect(bytesToHex(out)).toBe("09d657bafbe49950f21340e41188aee5f403536db9c0a227e05ee68382ae70f6");
  });

  it("PBKDF2-HMAC-SHA3-256 matches the native leancrypto output", async () => {
    const password = new TextEncoder().encode("password123");
    const salt = Uint8Array.from({ length: 32 }, (_, i) => i);
    const out = await pbkdf2Sha3_256(password, salt, 1000, 64);
    expect(bytesToHex(out)).toBe(
      "593dc3eb6cf6571d928819a219be8f946c15c2bb3adf0bd2e5e6b639fb909c31cfc79c2e12432dfbe599a0b7752a3ef" +
        "39490f67608413c77a7aad449a0404c75",
    );
  });

  it("Ascon-Keccak AEAD encrypt matches the native leancrypto output", async () => {
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    const iv = Uint8Array.from({ length: 64 }, (_, i) => i + 64);
    const aad = new TextEncoder().encode("AADDATA1234567890123456789012345678901234567890123456789012345678");
    const pt = new TextEncoder().encode("hello leancrypto aead roundtrip test payload");
    const { ciphertext, tag } = await aeadEncrypt(key, iv, aad, pt, 64);
    expect(bytesToHex(ciphertext)).toBe(
      "ddc5654d645ea318b3c34d76d14acf1e4f5e52500bc1c836b1b0eb1e9a2918e971cc46441ec9ff3b92f81188",
    );
    expect(bytesToHex(tag)).toBe(
      "e38b16eba1ad289a10474dc128e874132f323df323f884b84658e4b8216996e4a1b6c1d18f349377876450f0b06262227a1e9835ee7b641d05dd8d9cdfde8d78",
    );
  });

  it("Ascon-Keccak AEAD decrypt recovers the plaintext", async () => {
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    const iv = Uint8Array.from({ length: 64 }, (_, i) => i + 64);
    const aad = new TextEncoder().encode("AADDATA1234567890123456789012345678901234567890123456789012345678");
    const ciphertext = hexToBytes(
      "ddc5654d645ea318b3c34d76d14acf1e4f5e52500bc1c836b1b0eb1e9a2918e971cc46441ec9ff3b92f81188",
    );
    const tag = hexToBytes(
      "e38b16eba1ad289a10474dc128e874132f323df323f884b84658e4b8216996e4a1b6c1d18f349377876450f0b06262227a1e9835ee7b641d05dd8d9cdfde8d78",
    );
    const pt = await aeadDecrypt(key, iv, aad, ciphertext, tag);
    expect(new TextDecoder().decode(pt)).toBe("hello leancrypto aead roundtrip test payload");
  });

  it("AEAD decrypt rejects a tampered tag", async () => {
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    const iv = Uint8Array.from({ length: 64 }, (_, i) => i + 64);
    const aad = new TextEncoder().encode("aad");
    const pt = new TextEncoder().encode("secret");
    const { ciphertext, tag } = await aeadEncrypt(key, iv, aad, pt, 64);
    const badTag = tag.slice();
    badTag[0] ^= 0xff;
    await expect(aeadDecrypt(key, iv, aad, ciphertext, badTag)).rejects.toThrow();
  });
});

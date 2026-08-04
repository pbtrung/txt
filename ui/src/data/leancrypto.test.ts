import { describe, expect, it } from "vitest";

import { aeadDecrypt, aeadEncrypt, hkdf } from "./leancrypto";
import { bytesToHex, hexToBytes } from "../crypto/testUtil";

// Same known-good vectors as txt/crypto.ts's own test vectors
// (cross-checked by hand against the real native leancrypto library) --
// HKDF-SHA3-512 and Ascon-Keccak AEAD are the same underlying primitive
// regardless of which caller drives leancrypto.js's raw lc_hkdf/
// lc_ak_alloc_taglen context API, so identical inputs must still produce
// identical output.

describe("leancrypto", () => {
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

  it("Ascon-Keccak AEAD encrypt matches the native leancrypto output", async () => {
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    const iv = Uint8Array.from({ length: 64 }, (_, i) => i + 64);
    const aad = new TextEncoder().encode(
      "AADDATA1234567890123456789012345678901234567890123456789012345678",
    );
    const pt = new TextEncoder().encode(
      "hello leancrypto aead roundtrip test payload",
    );
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
    const aad = new TextEncoder().encode(
      "AADDATA1234567890123456789012345678901234567890123456789012345678",
    );
    const ciphertext = hexToBytes(
      "ddc5654d645ea318b3c34d76d14acf1e4f5e52500bc1c836b1b0eb1e9a2918e971cc46441ec9ff3b92f81188",
    );
    const tag = hexToBytes(
      "e38b16eba1ad289a10474dc128e874132f323df323f884b84658e4b8216996e4a1b6c1d18f349377876450f0b06262227a1e9835ee7b641d05dd8d9cdfde8d78",
    );
    const pt = await aeadDecrypt(key, iv, aad, ciphertext, tag);
    expect(new TextDecoder().decode(pt)).toBe(
      "hello leancrypto aead roundtrip test payload",
    );
  });

  it("AEAD decrypt rejects a tampered tag", async () => {
    const key = Uint8Array.from({ length: 64 }, (_, i) => i);
    const iv = Uint8Array.from({ length: 64 }, (_, i) => i + 64);
    const aad = new TextEncoder().encode("aad");
    const pt = new TextEncoder().encode("secret");
    const { ciphertext, tag } = await aeadEncrypt(key, iv, aad, pt, 64);
    const badTag = tag.slice();
    badTag[0] ^= 0xff;
    await expect(
      aeadDecrypt(key, iv, aad, ciphertext, badTag),
    ).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import * as blob from "./blob";
import fixtures from "./__fixtures__/vectors.json";
import { base64ToBytes, bytesToHex } from "./testUtil";

describe("blob", () => {
  it("encrypt() matches txt/crypto.py's Blob.encrypt byte-for-byte for an uncompressed payload", async () => {
    const { ikm, salt, payload, blob: expected } = fixtures.plainBlob;
    const result = await blob.encrypt(base64ToBytes(ikm), base64ToBytes(payload), {
      salt: base64ToBytes(salt),
      compressed: false,
    });
    expect(bytesToHex(result)).toBe(bytesToHex(base64ToBytes(expected)));
  });

  it("decrypt() recovers a plain blob produced by txt/crypto.py's Blob.encrypt", async () => {
    const { ikm, payload, blob: encoded } = fixtures.plainBlob;
    const result = await blob.decrypt(base64ToBytes(ikm), base64ToBytes(encoded), false);
    expect(bytesToHex(result)).toBe(bytesToHex(base64ToBytes(payload)));
  });

  it("decrypt() reads a brotli-compressed blob produced by Python's brotli + txt/crypto.py", async () => {
    // Brotli encoders aren't byte-deterministic across implementations, so
    // this only checks the JS *decoder* against Python-brotli-compressed
    // ciphertext -- the direction that actually matters for reading a vault
    // ingested by the Python CLI.
    const { ikm, payload, blob: encoded } = fixtures.compressedBlob;
    const result = await blob.decrypt(base64ToBytes(ikm), base64ToBytes(encoded), true);
    expect(bytesToHex(result)).toBe(bytesToHex(base64ToBytes(payload)));
  });

  it("round-trips an uncompressed payload", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(64));
    const payload = new TextEncoder().encode("round trip me");
    const encoded = await blob.encrypt(ikm, payload);
    const decoded = await blob.decrypt(ikm, encoded, false);
    expect(new TextDecoder().decode(decoded)).toBe("round trip me");
  });

  it("round-trips a compressed (brotli) JSON payload", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(64));
    const payload = new TextEncoder().encode(JSON.stringify({ a: 1, b: [1, 2, 3], s: "x".repeat(500) }));
    const encoded = await blob.encrypt(ikm, payload, { compressed: true });
    const decoded = await blob.decrypt(ikm, encoded, true);
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual({ a: 1, b: [1, 2, 3], s: "x".repeat(500) });
  });

  it("rejects a blob with the wrong IKM", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(64));
    const wrongIkm = crypto.getRandomValues(new Uint8Array(64));
    const encoded = await blob.encrypt(ikm, new TextEncoder().encode("secret"));
    await expect(blob.decrypt(wrongIkm, encoded, false)).rejects.toThrow();
  });

  it("rejects a blob shorter than the minimum length", async () => {
    await expect(blob.decrypt(new Uint8Array(64), new Uint8Array(10), false)).rejects.toThrow(
      "blob shorter than minimum valid length",
    );
  });

  it("rejects a blob with bad magic bytes", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(64));
    const encoded = await blob.encrypt(ikm, new TextEncoder().encode("secret"));
    encoded[0] ^= 0xff;
    await expect(blob.decrypt(ikm, encoded, false)).rejects.toThrow("bad magic");
  });
});

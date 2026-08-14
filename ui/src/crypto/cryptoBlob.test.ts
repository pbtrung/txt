import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./cryptoBlob";

describe("cryptoBlob (real sqlcipher.wasm)", () => {
  it("round-trips a plaintext blob under a fixed ikm", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(128));
    const plaintext = new TextEncoder().encode("some AA-stored secret value");

    const blob = await encrypt(plaintext, ikm);
    const decrypted = await decrypt(blob, ikm);

    expect(new TextDecoder().decode(decrypted)).toBe("some AA-stored secret value");
  });

  it("produces a different salt (and ciphertext) on each encrypt call", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(128));
    const plaintext = new TextEncoder().encode("same input, different blobs");

    const blobA = await encrypt(plaintext, ikm);
    const blobB = await encrypt(plaintext, ikm);

    expect([...blobA]).not.toEqual([...blobB]);
  });

  it("rejects decryption under the wrong ikm", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(128));
    const wrongIkm = crypto.getRandomValues(new Uint8Array(128));
    const blob = await encrypt(new TextEncoder().encode("secret"), ikm);

    await expect(decrypt(blob, wrongIkm)).rejects.toThrow();
  });

  it("rejects a blob shorter than the minimum length", async () => {
    await expect(decrypt(new Uint8Array(10), new Uint8Array(128))).rejects.toThrow(/too short/);
  });

  it("rejects a blob with the wrong magic", async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(128));
    const blob = await encrypt(new TextEncoder().encode("secret"), ikm);
    blob[0] ^= 0xff;

    await expect(decrypt(blob, ikm)).rejects.toThrow(/bad magic/);
  });
});

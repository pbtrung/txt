import { describe, expect, it } from "vitest";
import { brotliCompress } from "../../src/crypto/brotli";
import { decodeCatalog } from "../../src/data/catalog";

async function blob(value: unknown): Promise<Uint8Array> {
  return brotliCompress(new TextEncoder().encode(JSON.stringify(value)));
}

describe("decodeCatalog", () => {
  it("normalizes optional catalog fields", async () => {
    await expect(decodeCatalog(await blob({ title: "Dune" }))).resolves.toEqual({
      title: "Dune",
      authors: [],
      subjects: [],
      publisher: null,
    });
  });

  it("rejects malformed field types", async () => {
    await expect(
      decodeCatalog(await blob({ title: "Dune", authors: "Frank Herbert" })),
    ).rejects.toThrow(/authors/);
    await expect(
      decodeCatalog(await blob({ title: "Dune", publisher: 42 })),
    ).rejects.toThrow(/publisher/);
  });
});

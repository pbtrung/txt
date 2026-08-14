import { describe, expect, it } from "vitest";
import { encrypt } from "../crypto/cryptoBlob";
import { loadBundle } from "./bundle";
import type { CellValue } from "./libsql";
import type { R2 } from "./r2";
import type { Aa } from "./session";

class FakeAa implements Aa {
  constructor(private readonly rows: CellValue[][]) {}
  async query(): Promise<CellValue[][]> {
    return this.rows;
  }
}

class FakeR2 implements R2 {
  public requestedKeys: string[] = [];
  constructor(private readonly objects: Record<string, Uint8Array>) {}
  async getObject(key: string): Promise<Uint8Array> {
    this.requestedKeys.push(key);
    return this.objects[key];
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

describe("loadBundle", () => {
  it("returns null when there is no live bundle", async () => {
    expect(await loadBundle(new FakeAa([]), randomBytes(128), "prefix123", new FakeR2({}))).toBeNull();
  });

  it("unwraps the bundle keys, then fetches and decrypts the bundle object (no brotli)", async () => {
    const umk = randomBytes(128);
    const bundleEncKey = randomBytes(128);
    const plaintext = new TextEncoder().encode("pretend header+map+pages+index bytes");

    const aa = new FakeAa([
      [await encrypt(new TextEncoder().encode("bundle-obj"), bundleEncKey), await encrypt(bundleEncKey, umk)],
    ]);
    const r2 = new FakeR2({ "prefix123/b/bundle-obj": await encrypt(plaintext, bundleEncKey) });

    const result = await loadBundle(aa, umk, "prefix123", r2);
    expect(new TextDecoder().decode(result!)).toBe("pretend header+map+pages+index bytes");
    expect(r2.requestedKeys).toEqual(["prefix123/b/bundle-obj"]);
  });
});

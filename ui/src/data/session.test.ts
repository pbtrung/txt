import { describe, expect, it } from "vitest";
import { encrypt, encryptJson } from "../crypto/cryptoBlob";
import type { CellValue } from "./libsql";
import type { Aa } from "./session";
import { readActiveBundleKeys, readCredStore, readDbPrefix, readLibraryIndexKeys, readUmk } from "./session";

class FakeAa implements Aa {
  private readonly rows: Array<[string, CellValue[][]]> = [];

  when(needle: string, rows: CellValue[][]): this {
    this.rows.push([needle, rows]);
    return this;
  }

  async query(sql: string): Promise<CellValue[][]> {
    const match = this.rows.find(([needle]) => sql.includes(needle));
    return match ? match[1] : [];
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

describe("session key-unwrap chain (real cryptoBlob)", () => {
  it("readUmk decrypts key_store.umk under the root key, or returns null if absent", async () => {
    const ikm = randomBytes(256);
    const umk = randomBytes(128);
    const aa = new FakeAa().when("FROM key_store", [[await encrypt(umk, ikm)]]);

    expect([...(await readUmk(aa, ikm))!]).toEqual([...umk]);
    expect(await readUmk(new FakeAa(), ikm)).toBeNull();
  });

  it("readDbPrefix decrypts meta.db_prefix as UTF-8 text", async () => {
    const umk = randomBytes(128);
    const aa = new FakeAa().when("FROM meta", [[await encrypt(new TextEncoder().encode("abcdef123456"), umk)]]);

    expect(await readDbPrefix(aa, umk)).toBe("abcdef123456");
  });

  it("readDbPrefix throws when meta has no row", async () => {
    await expect(readDbPrefix(new FakeAa(), randomBytes(128))).rejects.toThrow(/meta row missing/);
  });

  it("readCredStore reads the user's single row (id = 1) for a non-admin account", async () => {
    const umk = randomBytes(128);
    const payload = { user_id: "uid-1", display_name: "Ada", db_master_key: "b64", db_prefix: "abc" };
    const aa = new FakeAa().when("WHERE id = 1", [[await encryptJson(payload, umk)]]);

    expect(await readCredStore(aa, umk, "user", "uid-1")).toEqual(payload);
  });

  it("readCredStore reads by user_id for an admin account", async () => {
    const umk = randomBytes(128);
    const payload = { user_id: "uid-admin", display_name: "Root", db_master_key: "b64", db_prefix: "xyz" };
    const aa = new FakeAa().when("WHERE user_id = ?", [[await encryptJson(payload, umk)]]);

    expect(await readCredStore(aa, umk, "admin", "uid-admin")).toEqual(payload);
  });

  it("readLibraryIndexKeys decrypts both object_key and lib_idx_key directly under umk", async () => {
    const umk = randomBytes(128);
    const libIdxKey = randomBytes(128);
    const aa = new FakeAa().when("FROM library_index", [
      [await encrypt(new TextEncoder().encode("some-object-key"), umk), await encrypt(libIdxKey, umk)],
    ]);

    const result = await readLibraryIndexKeys(aa, umk);
    expect(result?.objectKey).toBe("some-object-key");
    expect([...result!.libIdxKey]).toEqual([...libIdxKey]);
  });

  it("readLibraryIndexKeys returns null when no row exists yet", async () => {
    expect(await readLibraryIndexKeys(new FakeAa(), randomBytes(128))).toBeNull();
  });

  it("readActiveBundleKeys unwraps bundle_enc_key under umk, then bundle_key under bundle_enc_key", async () => {
    const umk = randomBytes(128);
    const bundleEncKey = randomBytes(128);
    const aa = new FakeAa().when("FROM bundles", [
      [await encrypt(new TextEncoder().encode("bundle-object-key"), bundleEncKey), await encrypt(bundleEncKey, umk)],
    ]);

    const result = await readActiveBundleKeys(aa, umk);
    expect(result?.bundleKey).toBe("bundle-object-key");
    expect([...result!.bundleEncKey]).toEqual([...bundleEncKey]);
  });

  it("readActiveBundleKeys returns null when there is no live bundle", async () => {
    expect(await readActiveBundleKeys(new FakeAa(), randomBytes(128))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { LibraryDatabaseStore } from "../../src/data/databaseStore";
import { R2ConflictError, type R2Object } from "../../src/data/r2";
import type { R2Session } from "../../src/data/r2Session";
import { SqliteDatabase } from "../../src/data/sqlite";
import { buildKeyedSqliteFixture } from "../../src/testUtils/sqliteFixture";

function key(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(256));
}

class FakeStorage {
  remote: R2Object | null;
  putEtags: Array<string | null> = [];
  failOnce = false;

  constructor(remote: R2Object | null) {
    this.remote = remote;
  }

  async getDatabase(): Promise<R2Object | null> {
    return this.remote
      ? { bytes: new Uint8Array(this.remote.bytes), etag: this.remote.etag }
      : null;
  }

  async putDatabase(bytes: Uint8Array, expectedEtag: string | null): Promise<string> {
    this.putEtags.push(expectedEtag);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("network unavailable");
    }
    if (expectedEtag !== (this.remote?.etag ?? null)) {
      throw new R2ConflictError("conflict");
    }
    const next = `"etag-${this.putEtags.length}"`;
    this.remote = { bytes: new Uint8Array(bytes), etag: next };
    return next;
  }
}

async function initialDatabase(dbKey: Uint8Array): Promise<Uint8Array> {
  return buildKeyedSqliteFixture(dbKey, [
    "PRAGMA page_size = 16384",
    "CREATE TABLE values_for_test(value TEXT PRIMARY KEY)",
    "INSERT INTO values_for_test VALUES ('initial')",
  ]);
}

async function remoteValues(
  storage: FakeStorage,
  dbKey: Uint8Array,
): Promise<string[]> {
  const db = await SqliteDatabase.openKeyed(dbKey, storage.remote!.bytes);
  db.execSql("PRAGMA page_size = 16384");
  const values = db
    .query("SELECT value FROM values_for_test ORDER BY value")
    .map(([value]) => value as string);
  db.close();
  return values;
}

describe("LibraryDatabaseStore", () => {
  it("serializes mutations and advances the exact ETag", async () => {
    const dbKey = key();
    const storage = new FakeStorage({
      bytes: await initialDatabase(dbKey),
      etag: '"etag-0"',
    });
    const store = await LibraryDatabaseStore.open(
      storage as unknown as R2Session,
      dbKey,
    );

    const first = store.mutate({
      description: "add a",
      apply: (db) => db.execute("INSERT INTO values_for_test VALUES (?)", ["a"]),
    });
    const second = store.mutate({
      description: "add b",
      apply: (db) => db.execute("INSERT INTO values_for_test VALUES (?)", ["b"]),
    });
    await Promise.all([first, second]);

    expect(storage.putEtags).toEqual(['"etag-0"', '"etag-1"']);
    expect(await remoteValues(storage, dbKey)).toEqual(["a", "b", "initial"]);
    expect(store.snapshot()).toEqual({ pending: false, unsaved: false, error: null });
    await store.close();
  });

  it("reloads a conflicting database and replays the semantic mutation", async () => {
    const dbKey = key();
    const storage = new FakeStorage({
      bytes: await initialDatabase(dbKey),
      etag: '"etag-0"',
    });
    const store = await LibraryDatabaseStore.open(
      storage as unknown as R2Session,
      dbKey,
    );

    const external = await SqliteDatabase.openKeyed(dbKey, storage.remote!.bytes);
    external.execSql("PRAGMA page_size = 16384");
    external.execute("INSERT INTO values_for_test VALUES (?)", ["external"]);
    storage.remote = {
      bytes: new Uint8Array(external.toBytes()),
      etag: '"external-etag"',
    };
    external.close();

    await store.mutate({
      description: "add local",
      apply: (db) => db.execute("INSERT INTO values_for_test VALUES (?)", ["local"]),
    });

    expect(storage.putEtags).toEqual(['"etag-0"', '"external-etag"']);
    expect(await remoteValues(storage, dbKey)).toEqual([
      "external",
      "initial",
      "local",
    ]);
    await store.close();
  });

  it("uses If-None-Match semantics for a new database", async () => {
    const dbKey = key();
    const storage = new FakeStorage(null);
    const store = await LibraryDatabaseStore.open(
      storage as unknown as R2Session,
      dbKey,
    );

    await store.mutate({
      description: "create test table",
      apply: (db) => db.execSql("CREATE TABLE created(value TEXT)"),
    });

    expect(storage.putEtags).toEqual([null]);
    expect(storage.remote).not.toBeNull();
    await store.close();
  });

  it("retains a failed semantic mutation for explicit retry", async () => {
    const dbKey = key();
    const storage = new FakeStorage({
      bytes: await initialDatabase(dbKey),
      etag: '"etag-0"',
    });
    storage.failOnce = true;
    const store = await LibraryDatabaseStore.open(
      storage as unknown as R2Session,
      dbKey,
    );

    await expect(
      store.mutate({
        description: "add retry",
        apply: (db) => db.execute("INSERT INTO values_for_test VALUES (?)", ["retry"]),
      }),
    ).rejects.toThrow("network unavailable");
    expect(store.snapshot()).toMatchObject({ unsaved: true });

    await store.retry();

    expect(await remoteValues(storage, dbKey)).toEqual(["initial", "retry"]);
    expect(store.snapshot()).toEqual({ pending: false, unsaved: false, error: null });
    await store.close();
  });
});

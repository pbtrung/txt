import { describe, expect, it } from "vitest";
import { buildSqliteFixture as buildFixtureBytes } from "../testUtils/sqliteFixture";
import { openSqliteFromBytes } from "./sqlite";

describe("sqlite (real sqlcipher.wasm, unkeyed)", () => {
  it("reads back integer, text, and blob columns", async () => {
    const bytes = await buildFixtureBytes([
      "CREATE TABLE t(a INTEGER, b TEXT, c BLOB);",
      "INSERT INTO t VALUES (42, 'hello', x'010203');",
    ]);

    const db = await openSqliteFromBytes(bytes);
    const rows = db.query("SELECT a, b, c FROM t;");
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(42);
    expect(rows[0][1]).toBe("hello");
    expect([...(rows[0][2] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("reads back a NULL column", async () => {
    const bytes = await buildFixtureBytes(["CREATE TABLE t(a);", "INSERT INTO t VALUES (NULL);"]);

    const db = await openSqliteFromBytes(bytes);
    const rows = db.query("SELECT a FROM t;");
    db.close();

    expect(rows[0][0]).toBeNull();
  });

  it("reads multiple rows in order", async () => {
    const bytes = await buildFixtureBytes([
      "CREATE TABLE t(a INTEGER);",
      "INSERT INTO t VALUES (1), (2), (3);",
    ]);

    const db = await openSqliteFromBytes(bytes);
    const rows = db.query("SELECT a FROM t ORDER BY a;");
    db.close();

    expect(rows.map((r) => r[0])).toEqual([1, 2, 3]);
  });

  it("throws a descriptive error for invalid SQL", async () => {
    const bytes = await buildFixtureBytes(["CREATE TABLE t(a);"]);
    const db = await openSqliteFromBytes(bytes);

    expect(() => db.query("SELECT * FROM nonexistent;")).toThrow(/no such table/);
    db.close();
  });

  it("binds integer, text, and blob parameters", async () => {
    const bytes = await buildFixtureBytes(["CREATE TABLE t(a INTEGER, b TEXT, c BLOB);", "INSERT INTO t VALUES (1, 'x', x'01');"]);

    const db = await openSqliteFromBytes(bytes);
    const rows = db.query("SELECT b FROM t WHERE a = ? AND b = ? AND c = ?", [1, "x", new Uint8Array([1])]);
    db.close();

    expect(rows).toEqual([["x"]]);
  });

  it("binds a null parameter", async () => {
    const bytes = await buildFixtureBytes(["CREATE TABLE t(a);", "INSERT INTO t VALUES (NULL), (1);"]);

    const db = await openSqliteFromBytes(bytes);
    const rows = db.query("SELECT a FROM t WHERE a IS ?", [null]);
    db.close();

    expect(rows).toEqual([[null]]);
  });
});

// End-to-end test for remoteGc.ts's RemoteRqliteDb/sweepGarbageRemote --
// same scenario as collectGarbage.test.ts (a few real commits creating
// superseded page versions, one expired and one live reader lease), but
// driven entirely over HTTP against a mock server whose handler executes
// each RAW_QUERY's *literal* SQL text against a real SqliteDb -- so a typo
// in remoteGc.ts's SQL (table/column name, wrong placeholder count, ...)
// fails here the same way it would against a real rqlite server, not just
// against a canned response.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { RqliteDb } from "./rqliteDb.ts";
import { UserDb } from "./userDb.ts";
import { SqliteDb, type Statement } from "./sqlite.ts";
import { RqliteHttpClient } from "./rqliteHttpClient.ts";
import { RemoteRqliteDb, sweepGarbageRemote } from "./remoteGc.ts";

function bindArgs(stmt: Statement, args: unknown[]): void {
  args.forEach((arg, i) => {
    if (typeof arg === "string") stmt.bindText(i + 1, arg);
    else if (typeof arg === "number") stmt.bindInt64(i + 1, arg);
    else throw new Error(`test mock: unsupported RAW_QUERY arg type ${typeof arg}`);
  });
}

function selectRows(db: SqliteDb, sql: string, args: unknown[], columns: number): unknown[][] {
  const stmt = db.prepare(sql);
  bindArgs(stmt, args);
  const values: unknown[][] = [];
  while (stmt.step()) {
    const row: unknown[] = [];
    for (let i = 0; i < columns; i++) {
      row.push(stmt.columnIsNull(i) ? null : Number(stmt.columnInt64(i)));
    }
    values.push(row);
  }
  stmt.finalize();
  return values;
}

/** Executes one RAW_QUERY batch item's real SQL against a real SqliteDb,
 * mirroring what a real rqlite server would do. Dispatches by matching the
 * exact SQL shapes remoteGc.ts sends -- there are only a handful. */
function execRawQuery(
  db: SqliteDb,
  sql: string,
  args: unknown[],
): { values?: unknown[][]; rows_affected?: number } {
  const trimmed = sql.trim();
  if (/^SELECT reader_id FROM active_readers/.test(trimmed)) {
    const stmt = db.prepare(sql);
    bindArgs(stmt, args);
    const values: unknown[][] = [];
    while (stmt.step()) values.push([stmt.columnText(0)]);
    stmt.finalize();
    return { values };
  }
  if (/^SELECT page_no, version FROM pages/.test(trimmed)) {
    return { values: selectRows(db, sql, args, 2) };
  }
  if (/^SELECT/i.test(trimmed)) {
    return { values: selectRows(db, sql, args, 1) };
  }
  if (/^VACUUM/i.test(trimmed)) {
    db.exec("VACUUM;");
    return {};
  }
  db.run(sql, (stmt) => bindArgs(stmt, args));
  return { rows_affected: db.changes() };
}

function startMockRqliteServer(
  db: SqliteDb,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const item = body.batch[0];
      const result = execRawQuery(db, item.sql, item.args ?? []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [result] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function countRows(db: SqliteDb, sql: string): Promise<number> {
  const stmt = db.prepare(sql);
  stmt.step();
  const count = Number(stmt.columnInt64(0));
  stmt.finalize();
  return count;
}

test("sweepGarbageRemote: dry-run changes nothing, a real run removes exactly the garbage", async () => {
  const dbPath = "/tmp/txt-remote-gc-test-rqlite.db";
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // fine, nothing to remove
  }

  const rootKey = randomBytes(256);
  const rqliteDb = await RqliteDb.open(dbPath);
  const { userId } = rqliteDb.ensureAdmin("test-api-key");

  const userDb = await UserDb.create(rootKey);
  const commit = () => {
    const snap = userDb.snapshot();
    rqliteDb.commit(userId, snap.pageSize, snap.bytes);
  };
  commit(); // version 1: schema only
  userDb.insertTxt(randomBytes(128), "doc-one.txt", null, Date.now());
  commit(); // version 2
  userDb.insertTxt(randomBytes(128), "doc-two.txt", null, Date.now());
  commit(); // version 3 -- some version-2 pages are now superseded

  rqliteDb.insertActiveReader(userId, "expired-reader", 1, Date.now() - 1000);
  rqliteDb.insertActiveReader(userId, "live-reader", 2, Date.now() + 1_000_000);
  rqliteDb.flush();
  rqliteDb.close();

  const inspectDb = await SqliteDb.open("/remote-gc-test-inspect.db", {
    preload: fs.readFileSync(dbPath),
  });
  const mock = await startMockRqliteServer(inspectDb);
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "test-api-key");
    const remoteDb = new RemoteRqliteDb(client, userId);

    const beforePages = await countRows(inspectDb, "SELECT count(*) FROM pages;");

    const dryRunResult = await sweepGarbageRemote(remoteDb, { dryRun: true, verbose: false });
    assert.equal(dryRunResult.skipped, false);
    assert.equal(
      await countRows(inspectDb, "SELECT count(*) FROM pages;"),
      beforePages,
      "dry-run must not delete pages",
    );
    assert.equal(
      await countRows(inspectDb, "SELECT count(*) FROM active_readers;"),
      2,
      "dry-run must not delete reader leases",
    );
    assert.equal(
      await countRows(inspectDb, "SELECT needs_gc FROM db_meta;"),
      1,
      "dry-run must not clear needs_gc",
    );

    const realResult = await sweepGarbageRemote(remoteDb, { dryRun: false, verbose: false });
    assert.equal(realResult.skipped, false);
    assert.ok(realResult.pagesRemoved > 0, "should have removed superseded page versions");
    assert.equal(realResult.readersRemoved, 1, "only the expired reader should be removed");

    const afterPages = await countRows(inspectDb, "SELECT count(*) FROM pages;");
    assert.ok(afterPages < beforePages, "a real run should remove superseded page versions");
    assert.equal(
      await countRows(inspectDb, "SELECT count(*) FROM active_readers;"),
      1,
      "only the expired reader should be removed",
    );
    assert.equal(
      await countRows(inspectDb, "SELECT needs_gc FROM db_meta;"),
      0,
      "a real run clears needs_gc",
    );
    assert.equal(
      await countRows(inspectDb, "SELECT count(*) FROM gc_runs;"),
      1,
      "a real run records today's gc_runs row",
    );

    const noopResult = await sweepGarbageRemote(remoteDb, { dryRun: false, verbose: false });
    assert.equal(noopResult.skipped, true, "a second run with nothing new to do must be a no-op");
  } finally {
    await mock.close();
    inspectDb.close();
  }
});

test("RemoteRqliteDb.vacuum(): sends a plain VACUUM via RAW_QUERY execute", async () => {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{}] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${port}`, "key");
    await new RemoteRqliteDb(client, "user-1").vacuum();

    assert.equal(requests[0].url, "/db/execute");
    assert.deepEqual(requests[0].body, {
      statementId: "RAW_QUERY",
      batch: [{ sql: "VACUUM" }],
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

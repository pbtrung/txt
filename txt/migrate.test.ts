// End-to-end test for --migrate: builds a synthetic old-vault SQLite file
// (same shape as docs/data_model.md @ 1ed39d43) plus a tiny local mock
// S3/R2 server, runs MigrateCommand against them, and verifies the
// resulting rqlite_txt.db. Never touches the real turso_txt.db/creds/
// live R2 bucket in this repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import fs from "node:fs";
import http from "node:http";
import { SqliteDb } from "./sqlite.ts";
import { BlobCipher } from "./blobCipher.ts";
import { loadWasm } from "./wasm.ts";
import { MigrateCommand } from "./migrate.ts";

interface MockR2 {
  port: number;
  store: Map<string, Buffer>;
  close: () => Promise<void>;
}

function startMockR2(bucket: string): Promise<MockR2> {
  const store = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url!, "http://x").pathname;
    const key = decodeURIComponent(pathname.replace(`/${bucket}/`, ""));
    if (req.method === "GET") return void serveGet(store, key, res);
    if (req.method === "PUT") return void servePut(store, key, req, res);
    if (req.method === "DELETE") return void (store.delete(key), res.writeHead(204).end());
    res.writeHead(405).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, store, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function serveGet(store: Map<string, Buffer>, key: string, res: http.ServerResponse): void {
  const body = store.get(key);
  if (!body) return void res.writeHead(404).end();
  res.writeHead(200).end(body);
}

function servePut(
  store: Map<string, Buffer>,
  key: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    store.set(key, Buffer.concat(chunks));
    res.writeHead(200).end();
  });
}

interface OldFixture {
  oldDbPath: string;
  rootKey: Buffer;
  part0Text: Buffer;
  part1Text: Buffer;
  oldPath0: string;
  oldPath1: string;
  metadataObjectPath: string;
}

async function buildOldVault(cipher: BlobCipher, store: Map<string, Buffer>): Promise<OldFixture> {
  const rootKey = randomBytes(256);
  const umk = randomBytes(64);
  const txtKey = randomBytes(64);
  const metadataKey = randomBytes(64);
  const part0Text = Buffer.from("Hello, this is part zero of the document.");
  const part1Text = Buffer.from("And this is part one, continuing the story.");
  const oldPath0 = "old-path-part-0";
  const oldPath1 = "old-path-part-1";
  store.set(oldPath0, cipher.encrypt(txtKey, brotliCompressSync(part0Text)));
  store.set(oldPath1, cipher.encrypt(txtKey, brotliCompressSync(part1Text)));

  const metadataJson = { "1": { name: "hello.txt", metadata: { author: "me" } } };
  const metadataObjectPath = "metadata-object-path";
  store.set(
    metadataObjectPath,
    cipher.encrypt(metadataKey, brotliCompressSync(Buffer.from(JSON.stringify(metadataJson)))),
  );
  const wrappedMetadataPath = cipher.encrypt(metadataKey, Buffer.from(metadataObjectPath, "ascii"));
  assert.ok(wrappedMetadataPath.length < 200, "fixture must exercise the wrapped-path branch");

  const db = await SqliteDb.open("/synthetic-old.db");
  db.exec(`
    CREATE TABLE umk_store (id INTEGER PRIMARY KEY, user_id INTEGER, umk BLOB);
    CREATE TABLE txt (id INTEGER PRIMARY KEY, user_id INTEGER, txt_key BLOB);
    CREATE TABLE txt_parts (id INTEGER PRIMARY KEY, txt_id INTEGER, part_num INTEGER, path BLOB);
    CREATE TABLE txt_metadata (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE, txt_metadata_key BLOB, content BLOB);
  `);
  db.run("INSERT INTO umk_store (user_id, umk) VALUES (1, ?);", (s) =>
    s.bindBlob(1, cipher.encrypt(rootKey, umk)),
  );
  db.run("INSERT INTO txt (id, user_id, txt_key) VALUES (1, 1, ?);", (s) =>
    s.bindBlob(1, cipher.encrypt(umk, txtKey)),
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 0, ?);", (s) =>
    s.bindBlob(1, cipher.encrypt(txtKey, Buffer.from(oldPath0, "ascii"))),
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 1, ?);", (s) =>
    s.bindBlob(1, cipher.encrypt(txtKey, Buffer.from(oldPath1, "ascii"))),
  );
  db.run("INSERT INTO txt_metadata (user_id, txt_metadata_key, content) VALUES (1, ?, ?);", (s) => {
    s.bindBlob(1, cipher.encrypt(umk, metadataKey));
    s.bindBlob(2, wrappedMetadataPath);
  });
  db.close();

  const mod = await loadWasm();
  const oldDbPath = "/tmp/txt-migrate-test-old-vault.db";
  fs.writeFileSync(oldDbPath, Buffer.from(mod.FS.readFile("/synthetic-old.db")));
  return { oldDbPath, rootKey, part0Text, part1Text, oldPath0, oldPath1, metadataObjectPath };
}

test("migrate: synthetic old vault end to end", async () => {
  const cipher = await BlobCipher.create();
  const bucket = "test-bucket";
  const mockR2 = await startMockR2(bucket);
  const fixture = await buildOldVault(cipher, mockR2.store);

  const inCredsPath = "/tmp/txt-migrate-test-in-creds.json";
  const outCredsPath = "/tmp/txt-migrate-test-out-creds.json";
  const outPath = "/tmp/txt-migrate-test-rqlite.db";
  fs.writeFileSync(
    inCredsPath,
    JSON.stringify({
      user_root_key: fixture.rootKey.toString("base64"),
      r2_config: {
        endpoint: `http://127.0.0.1:${mockR2.port}`,
        read_write_access_key_id: "dummy",
        read_write_secret_access_key: "dummy",
        region: "auto",
        bucket,
      },
    }),
  );
  fs.writeFileSync(
    outCredsPath,
    JSON.stringify({ user_root_key: randomBytes(256).toString("base64") }),
  );
  try {
    fs.unlinkSync(outPath);
  } catch {
    // fine, nothing to remove
  }

  await new MigrateCommand({
    inCredsPath,
    inPath: fixture.oldDbPath,
    outCredsPath,
    outPath,
    noDelete: false,
    verbose: false,
  }).run();

  const outCreds = JSON.parse(fs.readFileSync(outCredsPath, "utf8"));
  const outRootKey = Buffer.from(outCreds.user_root_key, "base64");
  await verifyOutput(outPath, outRootKey, mockR2.store, fixture);
  await mockR2.close();
});

async function verifyOutput(
  outPath: string,
  outRootKey: Buffer,
  store: Map<string, Buffer>,
  fixture: OldFixture,
): Promise<void> {
  const rqDb = await SqliteDb.open(outPath, { readOnly: true });
  const userId = readAdminUser(rqDb);
  const { pageBuffers, pageSize } = readPages(rqDb, userId);
  const keyHash = readApiKeyHash(rqDb, userId);
  rqDb.close();

  assert.match(keyHash, /^[A-Za-z0-9+/]+=*$/, "key_hash should look like base64");
  assert.equal(Buffer.from(keyHash, "base64").length, 32, "SHA3-256 digest is 32 bytes");

  const userDbBytes = Buffer.concat(pageBuffers);
  const userDbPath = "/tmp/txt-migrate-test-reassembled-user.db";
  fs.writeFileSync(userDbPath, userDbBytes);
  const userDb = await SqliteDb.open("/reassembled-user.db", {
    preload: fs.readFileSync(userDbPath),
    rawKey: outRootKey,
  });
  const { newTxtKey, newPaths } = readMigratedTxt(userDb);
  userDb.close();

  assert.equal(newPaths.length, 2, "expected 2 migrated parts");
  await assertPartsMigrated(store, newPaths, newTxtKey, fixture);
  assert.equal(store.has(fixture.oldPath0), false, "old part 0 should be deleted");
  assert.equal(store.has(fixture.oldPath1), false, "old part 1 should be deleted");
  assert.equal(store.has(fixture.metadataObjectPath), true, "metadata object must survive");
  void pageSize;
}

function readAdminUser(rqDb: SqliteDb): string {
  const stmt = rqDb.prepare("SELECT user_id, role FROM users;");
  assert.ok(stmt.step(), "expected one users row");
  const userId = stmt.columnText(0);
  assert.equal(stmt.columnText(1), "admin");
  stmt.finalize();
  return userId;
}

function readPages(rqDb: SqliteDb, userId: string): { pageBuffers: Buffer[]; pageSize: number } {
  const dm = rqDb.prepare("SELECT page_count, page_size FROM db_meta WHERE db_id = ?;");
  dm.bindText(1, userId);
  assert.ok(dm.step());
  const pageCount = Number(dm.columnInt64(0));
  const pageSize = Number(dm.columnInt64(1));
  dm.finalize();

  const stmt = rqDb.prepare("SELECT data FROM pages WHERE db_id = ? ORDER BY page_no;");
  stmt.bindText(1, userId);
  const pageBuffers: Buffer[] = [];
  while (stmt.step()) pageBuffers.push(stmt.columnBlob(0));
  stmt.finalize();
  assert.equal(pageBuffers.length, pageCount, "pages row count should equal db_meta.page_count");
  return { pageBuffers, pageSize };
}

function readApiKeyHash(rqDb: SqliteDb, userId: string): string {
  const stmt = rqDb.prepare("SELECT key_hash FROM api_keys WHERE user_id = ?;");
  stmt.bindText(1, userId);
  assert.ok(stmt.step());
  const keyHash = stmt.columnText(0);
  stmt.finalize();
  return keyHash;
}

function readMigratedTxt(userDb: SqliteDb): { newTxtKey: Buffer; newPaths: string[] } {
  const txtStmt = userDb.prepare("SELECT txt_key, name, metadata FROM txt;");
  assert.ok(txtStmt.step(), "expected one migrated txt row");
  const newTxtKey = txtStmt.columnBlob(0);
  assert.equal(txtStmt.columnText(1), "hello.txt");
  const metadataJson = JSON.parse(brotliDecompressSync(txtStmt.columnBlob(2)).toString("utf8"));
  assert.deepEqual(metadataJson, { author: "me" });
  txtStmt.finalize();

  const partsStmt = userDb.prepare("SELECT path FROM txt_parts ORDER BY part_num;");
  const newPaths: string[] = [];
  while (partsStmt.step()) newPaths.push(partsStmt.columnText(0));
  partsStmt.finalize();
  return { newTxtKey, newPaths };
}

async function assertPartsMigrated(
  store: Map<string, Buffer>,
  newPaths: string[],
  newTxtKey: Buffer,
  fixture: OldFixture,
): Promise<void> {
  const cipher = await BlobCipher.create();
  for (const [i, expected] of [fixture.part0Text, fixture.part1Text].entries()) {
    const objBody = store.get(newPaths[i]!);
    assert.ok(objBody, `new object at ${newPaths[i]} should exist in R2`);
    const decrypted = brotliDecompressSync(cipher.decrypt(newTxtKey, objBody!));
    assert.deepEqual(decrypted, expected, `part ${i} content should round-trip`);
  }
}

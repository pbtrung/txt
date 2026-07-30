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
  /** Keys added here make the next GET for them fail with a 500, simulating an outage. */
  failPaths: Set<string>;
  close: () => Promise<void>;
}

function startMockR2(bucket: string): Promise<MockR2> {
  const store = new Map<string, Buffer>();
  const failPaths = new Set<string>();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url!, "http://x").pathname;
    const key = decodeURIComponent(pathname.replace(`/${bucket}/`, ""));
    if (req.method === "GET") return void serveGet(store, failPaths, key, res);
    if (req.method === "PUT") return void servePut(store, key, req, res);
    if (req.method === "DELETE") return void (store.delete(key), res.writeHead(204).end());
    res.writeHead(405).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, store, failPaths, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function serveGet(
  store: Map<string, Buffer>,
  failPaths: Set<string>,
  key: string,
  res: http.ServerResponse,
): void {
  if (failPaths.has(key)) return void res.writeHead(500).end("simulated outage");
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
        read_only_access_key_id: "dummy",
        read_only_secret_access_key: "dummy",
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

  try {
    await new MigrateCommand({
      inCredsPath,
      inPath: fixture.oldDbPath,
      outCredsPath,
      outPath,
      noDelete: false,
      verbose: true,
    }).run();

    const outCreds = JSON.parse(fs.readFileSync(outCredsPath, "utf8"));
    const outRootKey = Buffer.from(outCreds.user_root_key, "base64");
    await verifyOutput(outPath, outRootKey, mockR2.store, fixture);
  } finally {
    await mockR2.close();
  }
});

interface TwoDocFixture {
  oldDbPath: string;
  rootKey: Buffer;
  doc1Name: string;
  doc2Name: string;
  doc2OldPath: string;
}

async function buildTwoDocOldVault(
  cipher: BlobCipher,
  store: Map<string, Buffer>,
): Promise<TwoDocFixture> {
  const rootKey = randomBytes(256);
  const umk = randomBytes(64);
  const metadataKey = randomBytes(64);
  const docs = [
    {
      id: 1,
      name: "doc1.txt",
      text: Buffer.from("content of the first document"),
      oldPath: "old-doc1-part-0",
    },
    {
      id: 2,
      name: "doc2.txt",
      text: Buffer.from("content of the second document"),
      oldPath: "old-doc2-part-0",
    },
  ];

  const db = await SqliteDb.open("/synthetic-old-two.db");
  db.exec(`
    CREATE TABLE umk_store (id INTEGER PRIMARY KEY, user_id INTEGER, umk BLOB);
    CREATE TABLE txt (id INTEGER PRIMARY KEY, user_id INTEGER, txt_key BLOB);
    CREATE TABLE txt_parts (id INTEGER PRIMARY KEY, txt_id INTEGER, part_num INTEGER, path BLOB);
    CREATE TABLE txt_metadata (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE, txt_metadata_key BLOB, content BLOB);
  `);
  db.run("INSERT INTO umk_store (user_id, umk) VALUES (1, ?);", (s) =>
    s.bindBlob(1, cipher.encrypt(rootKey, umk)),
  );

  const metadataJson: Record<string, { name: string }> = {};
  for (const doc of docs) {
    const txtKey = randomBytes(64);
    db.run("INSERT INTO txt (id, user_id, txt_key) VALUES (?, 1, ?);", (s) => {
      s.bindInt64(1, doc.id);
      s.bindBlob(2, cipher.encrypt(umk, txtKey));
    });
    db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (?, 0, ?);", (s) => {
      s.bindInt64(1, doc.id);
      s.bindBlob(2, cipher.encrypt(txtKey, Buffer.from(doc.oldPath, "ascii")));
    });
    store.set(doc.oldPath, cipher.encrypt(txtKey, brotliCompressSync(doc.text)));
    metadataJson[String(doc.id)] = { name: doc.name };
  }

  const metadataObjectPath = "metadata-object-path-two";
  store.set(
    metadataObjectPath,
    cipher.encrypt(metadataKey, brotliCompressSync(Buffer.from(JSON.stringify(metadataJson)))),
  );
  const wrappedMetadataPath = cipher.encrypt(metadataKey, Buffer.from(metadataObjectPath, "ascii"));
  db.run("INSERT INTO txt_metadata (user_id, txt_metadata_key, content) VALUES (1, ?, ?);", (s) => {
    s.bindBlob(1, cipher.encrypt(umk, metadataKey));
    s.bindBlob(2, wrappedMetadataPath);
  });
  db.close();

  const mod = await loadWasm();
  const oldDbPath = "/tmp/txt-migrate-resume-test-old-vault.db";
  fs.writeFileSync(oldDbPath, Buffer.from(mod.FS.readFile("/synthetic-old-two.db")));
  return {
    oldDbPath,
    rootKey,
    doc1Name: docs[0]!.name,
    doc2Name: docs[1]!.name,
    doc2OldPath: docs[1]!.oldPath,
  };
}

function readAllTxtNames(userDb: SqliteDb): string[] {
  const stmt = userDb.prepare("SELECT name FROM txt ORDER BY id;");
  const names: string[] = [];
  while (stmt.step()) names.push(stmt.columnText(0));
  stmt.finalize();
  return names;
}

test("migrate: resumes after a failure without reprocessing committed documents", async () => {
  const cipher = await BlobCipher.create();
  const bucket = "resume-bucket";
  const mockR2 = await startMockR2(bucket);
  const fixture = await buildTwoDocOldVault(cipher, mockR2.store);

  const inCredsPath = "/tmp/txt-migrate-resume-test-in-creds.json";
  const outCredsPath = "/tmp/txt-migrate-resume-test-out-creds.json";
  const outPath = "/tmp/txt-migrate-resume-test-rqlite.db";
  fs.writeFileSync(
    inCredsPath,
    JSON.stringify({
      user_root_key: fixture.rootKey.toString("base64"),
      r2_config: {
        endpoint: `http://127.0.0.1:${mockR2.port}`,
        read_only_access_key_id: "dummy",
        read_only_secret_access_key: "dummy",
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

  const opts = {
    inCredsPath,
    inPath: fixture.oldDbPath,
    outCredsPath,
    outPath,
    noDelete: false,
    verbose: false,
  };

  try {
    mockR2.failPaths.add(fixture.doc2OldPath);
    await assert.rejects(() => new MigrateCommand(opts).run());

    const outRootKey = await readOutRootKey(outCredsPath);
    const namesAfterFailure = await namesInOutput(outPath, outRootKey);
    assert.deepEqual(
      namesAfterFailure,
      [fixture.doc1Name],
      "only the first document should be committed",
    );
    assert.equal(
      mockR2.store.has(fixture.doc2OldPath),
      true,
      "doc2's old object must survive an aborted run",
    );

    mockR2.failPaths.delete(fixture.doc2OldPath);
    await new MigrateCommand(opts).run();

    const namesAfterResume = await namesInOutput(outPath, outRootKey);
    assert.deepEqual(
      namesAfterResume,
      [fixture.doc1Name, fixture.doc2Name],
      "resume should add only the missing document",
    );
    assert.equal(
      mockR2.store.has(fixture.doc2OldPath),
      false,
      "doc2's old object should be deleted once resumed",
    );
  } finally {
    await mockR2.close();
  }
});

async function readOutRootKey(outCredsPath: string): Promise<Buffer> {
  const outCreds = JSON.parse(fs.readFileSync(outCredsPath, "utf8"));
  return Buffer.from(outCreds.user_root_key, "base64");
}

async function namesInOutput(outPath: string, outRootKey: Buffer): Promise<string[]> {
  const rqDb = await SqliteDb.open(outPath, { readOnly: true });
  const userId = readAdminUser(rqDb);
  const { pageBuffers, pageSize } = readPages(rqDb, userId);
  rqDb.close();
  void pageSize;
  const userDbPath = "/tmp/txt-migrate-resume-test-reassembled.db";
  const bytes = Buffer.concat(pageBuffers);
  fs.writeFileSync(userDbPath, bytes);
  const userDb = await SqliteDb.open("/reassembled-resume-user.db", {
    preload: fs.readFileSync(userDbPath),
    rawKey: outRootKey,
  });
  const names = readAllTxtNames(userDb);
  userDb.close();
  return names;
}

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

// Pages are versioned (only changed pages get a new row per commit), so
// reconstructing the current file means "latest version <= current_version
// per page_no" -- the same lookup docs/data_model.md's idx_pages_lookup
// backs, checked independently here rather than via RqliteDb.latestPages.
function readPages(rqDb: SqliteDb, userId: string): { pageBuffers: Buffer[]; pageSize: number } {
  const dm = rqDb.prepare(
    "SELECT current_version, page_count, page_size FROM db_meta WHERE db_id = ?;",
  );
  dm.bindText(1, userId);
  assert.ok(dm.step());
  const currentVersion = Number(dm.columnInt64(0));
  const pageCount = Number(dm.columnInt64(1));
  const pageSize = Number(dm.columnInt64(2));
  dm.finalize();

  const pageBuffers: Buffer[] = [];
  for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
    pageBuffers.push(readLatestPage(rqDb, userId, pageNo, currentVersion));
  }
  return { pageBuffers, pageSize };
}

function readLatestPage(
  rqDb: SqliteDb,
  userId: string,
  pageNo: number,
  atOrBeforeVersion: number,
): Buffer {
  const stmt = rqDb.prepare(
    "SELECT data FROM pages WHERE db_id=? AND page_no=? AND version<=? ORDER BY version DESC LIMIT 1;",
  );
  stmt.bindText(1, userId);
  stmt.bindInt64(2, pageNo);
  stmt.bindInt64(3, atOrBeforeVersion);
  assert.ok(stmt.step(), `missing page ${pageNo} at or before version ${atOrBeforeVersion}`);
  const data = stmt.columnBlob(0);
  stmt.finalize();
  return data;
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

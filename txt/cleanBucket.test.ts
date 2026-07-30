// End-to-end test for --clean-bucket: seeds a small rqlite_txt.db (real
// admin account + a migrated document with two parts) and a mock R2 bucket
// holding those two objects plus two orphans, then verifies dry-run deletes
// nothing and a real run deletes only the orphans.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { RqliteDb } from "./rqliteDb.ts";
import { UserDb } from "./userDb.ts";
import { CleanBucketCommand } from "./cleanBucket.ts";

interface MockR2 {
  port: number;
  store: Map<string, Buffer>;
  close: () => Promise<void>;
}

function startMockR2(bucket: string, seed: Map<string, Buffer>): Promise<MockR2> {
  const store = new Map(seed);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url!, "http://x").pathname;
    if (req.method === "GET" && (pathname === `/${bucket}` || pathname === `/${bucket}/`)) {
      return void handleList(store, bucket, res);
    }
    const key = decodeURIComponent(pathname.replace(`/${bucket}/`, ""));
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

function handleList(store: Map<string, Buffer>, bucket: string, res: http.ServerResponse): void {
  const contents = [...store.keys()]
    .map((key) => `<Contents><Key>${key}</Key></Contents>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
  res.writeHead(200, { "Content-Type": "application/xml" }).end(xml);
}

async function buildRqliteFixture(): Promise<{
  dbPath: string;
  credsPath: string;
  keptPaths: string[];
}> {
  const rootKey = randomBytes(256);
  const dbPath = "/tmp/txt-clean-bucket-test-rqlite.db";
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // fine, nothing to remove
  }

  const rqliteDb = await RqliteDb.open(dbPath);
  const { userId } = rqliteDb.ensureAdmin({ tierId: "free", rate: 10, burst: 20 });
  const userDb = await UserDb.create(rootKey);
  const txtId = userDb.insertTxt(randomBytes(128), "kept.txt", null, Date.now());
  userDb.insertPart(txtId, 0n, "kept-path-0");
  userDb.insertPart(txtId, 1n, "kept-path-1");
  const snap = userDb.snapshot();
  rqliteDb.commit(userId, snap.pageSize, snap.bytes);
  rqliteDb.close();

  const credsPath = "/tmp/txt-clean-bucket-test-creds.json";
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      user_root_key: rootKey.toString("base64"),
      r2_config: {
        endpoint: "",
        read_only_access_key_id: "x",
        read_only_secret_access_key: "x",
        read_write_access_key_id: "x",
        read_write_secret_access_key: "x",
        region: "auto",
        bucket: "clean-bucket-test",
      },
    }),
  );
  return { dbPath, credsPath, keptPaths: ["kept-path-0", "kept-path-1"] };
}

test("clean-bucket: dry-run deletes nothing, real run deletes only orphans", async () => {
  const fixture = await buildRqliteFixture();
  const seed = new Map<string, Buffer>([
    ["kept-path-0", Buffer.from("kept content 0")],
    ["kept-path-1", Buffer.from("kept content 1")],
    ["orphan-path-a", Buffer.from("orphan a")],
    ["orphan-path-b", Buffer.from("orphan b")],
  ]);
  const bucket = "clean-bucket-test";
  const mockR2 = await startMockR2(bucket, seed);
  try {
    const credsForPort = { ...JSON.parse(fs.readFileSync(fixture.credsPath, "utf8")) };
    credsForPort.r2_config.endpoint = `http://127.0.0.1:${mockR2.port}`;
    fs.writeFileSync(fixture.credsPath, JSON.stringify(credsForPort));

    await new CleanBucketCommand({
      credsPath: fixture.credsPath,
      dbPath: fixture.dbPath,
      dryRun: true,
      verbose: false,
    }).run();
    assert.equal(mockR2.store.size, 4, "dry-run must not delete anything");

    await new CleanBucketCommand({
      credsPath: fixture.credsPath,
      dbPath: fixture.dbPath,
      dryRun: false,
      verbose: false,
    }).run();
    assert.deepEqual(
      [...mockR2.store.keys()].sort(),
      fixture.keptPaths.slice().sort(),
      "only the referenced paths should survive a real run",
    );
  } finally {
    await mockR2.close();
  }
});

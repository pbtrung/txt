// Real end-to-end smoke test -- not part of the regular fast unit suite
// (run explicitly: `npx vitest run --config ui/vite.config.ts src/smoke.e2e.test.ts`).
// Everything else in this port of the data layer has been verified with a
// real SQLCipher db (remoteVfs.test.ts, owner.test.ts, ...), but always with
// startRemotePageWorker/RqliteHttpClient mocked out -- nothing has yet
// proven that a real browser Worker + SharedArrayBuffer + Atomics.wait
// bridge actually works end to end, which is exactly the combination
// txt/commands.ts's own comment flags as unverified ("Atomics.wait was
// found to stall indefinitely in at least one sandboxed dev environment").
//
// This spins up: a real built ui/dist/ (via the actual `npm run ui:build`
// pipeline) served with the same Cross-Origin-Opener-Policy/
// Cross-Origin-Embedder-Policy headers docker/nginx.conf's port-4002 block
// sets; a minimal fake rqlite backend that speaks auth_perms.lua's exact
// wire protocol (GET_META/READ_PAGE/COMMIT) backed by a real SQLCipher db's
// real pages; and a real headless Chromium (via playwright-core, driving
// the system browser directly -- no bundled browser download). It drives
// the actual UnlockScreen file input, waits for the Library screen to
// render from real lazily-fetched pages, and exercises the two write paths
// reachable without R2 (remove-from-recent, remove-bookmark), checking the
// fake backend actually received a COMMIT with the expected version bump.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

import { SqliteDb } from "./data/sqliteDb";
import { loadWasm } from "./data/wasmLoader";
import { bytesToBase64 } from "./crypto/bytes";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(UI_DIR, "..");
const DIST_DIR = join(UI_DIR, "dist");
const CHROMIUM_PATH = "/usr/bin/chromium";

interface FakeDb {
  rootKey: Uint8Array;
  pages: Map<number, Uint8Array>;
  pageSize: number;
  pageCount: number;
  currentVersion: number;
}

async function buildFakeDb(): Promise<FakeDb> {
  const rootKey = randomBytes(256);
  const path = "/smoke-e2e-build.db";
  const db = await SqliteDb.open(path, { rawKey: rootKey });
  const pageSizeStmt = db.prepare("PRAGMA page_size;");
  pageSizeStmt.step();
  const pageSize = Number(pageSizeStmt.columnInt64(0));
  pageSizeStmt.finalize();

  db.exec(`
    CREATE TABLE txt (
      id INTEGER PRIMARY KEY, txt_key BLOB NOT NULL, name TEXT NOT NULL,
      metadata BLOB, last_part_num INTEGER, last_accessed INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE txt_parts (
      id INTEGER PRIMARY KEY, txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE txt_bookmarks (
      id INTEGER PRIMARY KEY, txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL,
      line INTEGER NOT NULL, preview TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (txt_id, part_num, line)
    );
  `);
  db.run(
    "INSERT INTO txt (id, txt_key, name, last_part_num, last_accessed, created_at) " +
      "VALUES (1, x'00', 'Smoke Test Book', 3, 5000, 1000);",
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 0, 'path-0');");
  db.run(
    "INSERT INTO txt_bookmarks (txt_id, part_num, line, preview, created_at) VALUES (1, 0, 1, ?, 2000);",
    (s) => s.bindText(1, "Smoke test bookmark preview"),
  );
  db.close();

  const mod = await loadWasm();
  const bytes = mod.FS.readFile(path);
  const pageCount = bytes.length / pageSize;
  const pages = new Map<number, Uint8Array>();
  for (let i = 0; i < pageCount; i++) {
    pages.set(i + 1, bytes.slice(i * pageSize, (i + 1) * pageSize));
  }
  return { rootKey, pages, pageSize, pageCount, currentVersion: 1 };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Minimal fake of docker/auth_perms.lua -- just enough of the real wire
 * protocol (GET_META/READ_PAGE/COMMIT) for the browser's real data layer to
 * talk to, backed by buildFakeDb()'s real pages. */
function startFakeBackend(
  fakeDb: FakeDb,
): Promise<{ url: string; readPageLog: number[]; close: () => Promise<void> }> {
  const readPageLog: number[] = [];
  const server = http.createServer((req, res) => {
    // The served page and this backend are genuinely different origins, so
    // the browser sends a CORS preflight (OPTIONS) before every real POST --
    // real auth_perms.lua's actual deployment sits behind the same nginx
    // host as the page in production, but this test's split-port setup
    // needs to handle that preflight itself.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    void (async () => {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      res.setHeader("Content-Type", "application/json");
      if (body.statementId === "GET_META") {
        res.end(
          JSON.stringify({
            results: [{ values: [[fakeDb.currentVersion, fakeDb.pageCount, fakeDb.pageSize]] }],
          }),
        );
        return;
      }
      if (body.statementId === "READ_PAGE") {
        const batch = body.batch as Array<{ page_no: number }>;
        const pageNo = batch[0]!.page_no;
        readPageLog.push(pageNo);
        const bytes = fakeDb.pages.get(pageNo);
        res.end(
          JSON.stringify({ results: [{ values: [[Buffer.from(bytes!).toString("base64")]] }] }),
        );
        return;
      }
      if (body.statementId === "COMMIT") {
        const commit = body.commit as {
          pages: Array<{ page_no: number; data: number[] }>;
          old_version: number;
          new_version: number;
          page_count: number;
        };
        if (commit.old_version !== fakeDb.currentVersion) {
          res.end(JSON.stringify({ results: [{}, { rows_affected: 0 }] }));
          return;
        }
        for (const page of commit.pages) {
          fakeDb.pages.set(page.page_no, Uint8Array.from(page.data));
        }
        fakeDb.currentVersion = commit.new_version;
        fakeDb.pageCount = commit.page_count;
        res.end(JSON.stringify({ results: [{}, { rows_affected: 1 }] }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: true }));
    })();
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        readPageLog,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Serves ui/dist/ with the same COOP/COEP headers docker/nginx.conf's
 * port-4002 block sets -- this is what makes SharedArrayBuffer available at
 * all, so the test would fail early (no SharedArrayBuffer) if this were
 * missing, the same way a misconfigured deployment would. */
function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".json": "application/json",
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    let filePath = join(DIST_DIR, decodeURIComponent((req.url ?? "/").split("?")[0]!));
    if (filePath.endsWith("/")) filePath = join(filePath, "index.html");
    try {
      const data = readFileSync(filePath);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      res.setHeader("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
      res.end(data);
    } catch {
      // SPA fallback, same as nginx.conf's try_files ... /index.html
      const indexData = readFileSync(join(DIST_DIR, "index.html"));
      res.setHeader("Content-Type", "text/html");
      res.end(indexData);
    }
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("real end-to-end smoke test (browser Worker + SharedArrayBuffer + Atomics bridge)", () => {
  let browser: Browser;
  let page: Page;
  let backend: Awaited<ReturnType<typeof startFakeBackend>>;
  let staticServer: Awaited<ReturnType<typeof startStaticServer>>;
  let tmpDir: string;
  let fakeDb: FakeDb;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ui-smoke-"));

    const buildCredsPath = join(tmpDir, "build-creds.json");
    writeFileSync(
      buildCredsPath,
      JSON.stringify({
        asset_base_url: "https://example.invalid/",
        rqlite_host: "https://example.invalid",
      }),
    );
    execFileSync("npm", ["run", "ui:build", "--", "--build-creds", buildCredsPath], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    fakeDb = await buildFakeDb();
    backend = await startFakeBackend(fakeDb);
    staticServer = await startStaticServer();

    const credsPath = join(tmpDir, "creds.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        rqlite_url: backend.url,
        api_key: "smoke-test-key",
        user_root_key: bytesToBase64(fakeDb.rootKey),
        r2_config: {
          endpoint: "https://example.invalid",
          region: "auto",
          bucket: "b",
          read_only_access_key_id: "id",
          read_only_secret_access_key: "secret",
        },
      }),
    );

    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox"],
    });
    page = await browser.newPage();
    page.on("console", (msg) => console.log(`[browser console/${msg.type()}]`, msg.text()));
    page.on("pageerror", (err) => console.error("[browser pageerror]", err));
    page.on("requestfailed", (req) =>
      console.error("[browser requestfailed]", req.url(), req.failure()?.errorText),
    );
    await page.goto(staticServer.url);
    await page.setInputFiles('input[aria-label="Choose config file"]', credsPath);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await staticServer?.close();
    await backend?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is cross-origin isolated with SharedArrayBuffer available", async () => {
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe("function");
  });

  it("unlocks and renders the Library screen with the real book title, fetched via lazy paging", async () => {
    await page.waitForSelector("text=Smoke Test Book", { timeout: 20_000 });
    expect(backend.readPageLog.length).toBeGreaterThan(0);
    // Proves this is genuinely page-at-a-time, not one big dump.
    expect(new Set(backend.readPageLog).size).toBeGreaterThan(1);
  }, 25_000);

  it("shows the pre-seeded bookmark under Recent Bookmarks", async () => {
    await page.waitForSelector("text=Smoke test bookmark preview", { timeout: 10_000 });
  }, 15_000);

  it("removes a bookmark via the real commit path, bumping the fake backend's version", async () => {
    const versionBefore = fakeDb.currentVersion;
    await page.click('button[aria-label="Remove this bookmark in Smoke Test Book"]');
    await page.waitForSelector("text=Smoke test bookmark preview", {
      state: "detached",
      timeout: 10_000,
    });
    expect(fakeDb.currentVersion).toBeGreaterThan(versionBefore);
  }, 15_000);

  it("removes the book from Recent via the real commit path, bumping the version again", async () => {
    const versionBefore = fakeDb.currentVersion;
    await page.click('button[aria-label="Remove Smoke Test Book from Recent"]');
    await page.waitForSelector("text=Smoke Test Book", { state: "detached", timeout: 10_000 });
    expect(fakeDb.currentVersion).toBeGreaterThan(versionBefore);
  }, 15_000);
});

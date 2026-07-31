// --test-perf: opens a real, remote user database lazily -- one page at a
// time, over real HTTP to a live OpenResty+rqlite deployment -- instead of
// the rest of txt/'s "read every page, build the full db in memory" model
// (see RqliteDb.latestPages/UserDb.resume). Runs a handful of SELECTs
// against it and reports how many network round trips that actually cost,
// to make the tradeoff against the full-preload model measurable rather
// than assumed.
//
// Not covered by a committed end-to-end test: txt/rqliteHttpClient.test.ts
// covers the real HTTP layer (main thread only, no worker) and
// txt/remoteVfs.test.ts covers the lazy VFS's paging/caching/decryption
// (fake synchronous fetchPage, no network), but the real worker+Atomics+HTTP
// round trip this file wires together wasn't verified end-to-end -- real
// network I/O issued by a worker thread while the main thread blocks in
// Atomics.wait was found to stall indefinitely in at least one sandboxed
// dev environment (a non-network worker response over the same bridge
// worked fine, ruling out Atomics.wait/SharedArrayBuffer mechanics
// themselves). Verify this specific combination manually against a real
// deployment before relying on it somewhere new.

import { Worker } from "node:worker_threads";
import { loadPerfCreds, rootKeyBytes, type PerfCreds } from "./creds.ts";
import { RqliteHttpClient, resultRows } from "./rqliteHttpClient.ts";
import { hashApiKey } from "./rqliteDb.ts";
import { loadWasm } from "./wasm.ts";
import { SqliteDb } from "./sqlite.ts";
import { registerRemoteVfs, type RemoteVfsStats } from "./remoteVfs.ts";

const BACKED_PATH = "/remote-user.db";
const CONTROL_STATUS = 0;
const CONTROL_LEN = 1;
const STATUS_ERROR = 2;
const FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_QUERIES = [
  "SELECT COUNT(*) FROM txt;",
  "SELECT id, name FROM txt ORDER BY last_accessed DESC LIMIT 10;",
  "SELECT id, name, metadata FROM txt LIMIT 1;",
  "SELECT COUNT(*) FROM txt_parts;",
  "SELECT txt_id, part_num, path FROM txt_parts LIMIT 10;",
];

export interface TestPerfOptions {
  credsPath: string;
  verbose: boolean;
}

interface Meta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
}

export interface QueryReport {
  sql: string;
  rows: number;
  ms: number;
  roundtrips: number;
}

interface Bridge {
  fetchPage: (pageNo: number) => Uint8Array;
  terminate: () => Promise<void>;
}

export interface TestPerfResult {
  reports: QueryReport[];
  stats: RemoteVfsStats;
}

export class TestPerfCommand {
  private readonly opts: TestPerfOptions;

  constructor(opts: TestPerfOptions) {
    this.opts = opts;
  }

  async run(): Promise<TestPerfResult> {
    const creds = loadPerfCreds(this.opts.credsPath);
    this.progress(`Loaded creds from ${this.opts.credsPath} (rqlite_url=${creds.rqlite_url})`);
    const client = new RqliteHttpClient(creds.rqlite_url, creds.api_key);

    this.progress("Resolving identity...");
    const targetDbId = await this.resolveTargetDbId(client, creds.api_key);
    this.progress(
      targetDbId
        ? `Resolved admin's own account: target_db_id=${targetDbId}`
        : "Resolved as a user-role key (db_id forced server-side)",
    );

    this.progress("Fetching db_meta...");
    const meta = await this.fetchMeta(client, targetDbId);
    this.progress(
      `db_meta: version=${meta.currentVersion} pages=${meta.pageCount} page_size=${meta.pageSize}`,
    );

    this.progress("Starting page-fetch worker...");
    const bridge = await this.startWorker(creds, targetDbId, meta);
    this.progress("Worker ready");
    try {
      return await this.openAndReport(creds, meta, bridge);
    } finally {
      await bridge.terminate();
    }
  }

  /**
   * GET_META/READ_PAGE are ordinary user-level statements, forced to the
   * caller's own db_id -- unless the key resolves to role='admin', which has
   * no implicit self and needs target_db_id named explicitly (see
   * auth_perms.lua). Rather than requiring the caller to already know its
   * own user_id, look it up the same way auth_perms.lua's own identity
   * resolution does: api_keys.key_hash -> users.user_id. This only works
   * for an admin key (RAW_QUERY is admin-only) -- for a genuine user-role
   * key it fails with the same "unknown statementId" 400 any other bogus
   * statementId gets, which is exactly how a plain user key is told apart
   * from an admin one here.
   */
  private async resolveTargetDbId(
    client: RqliteHttpClient,
    apiKey: string,
  ): Promise<string | undefined> {
    const batch = [
      { sql: "SELECT user_id FROM api_keys WHERE key_hash = ?", args: [hashApiKey(apiKey)] },
    ];
    try {
      const row = resultRows(await client.query("RAW_QUERY", batch))[0];
      return row ? String(row[0]) : undefined;
    } catch {
      return undefined; // not an admin key -- GET_META/READ_PAGE will force db_id server-side instead
    }
  }

  private async openAndReport(
    creds: PerfCreds,
    meta: Meta,
    bridge: Bridge,
  ): Promise<TestPerfResult> {
    const mod = await loadWasm();
    const { name, stats } = registerRemoteVfs(mod, {
      pageSize: meta.pageSize,
      pageCount: meta.pageCount,
      backedPath: BACKED_PATH,
      fetchPage: bridge.fetchPage,
    });
    this.progress("Opening database (read-only)...");
    const db = await SqliteDb.open(BACKED_PATH, {
      vfsName: name,
      rawKey: rootKeyBytes(creds),
      readOnly: true,
    });
    this.progress("Database opened\n");
    try {
      const reports = this.runQueries(db, stats);
      printSummary(reports, stats);
      return { reports, stats };
    } finally {
      db.close();
    }
  }

  /** Always printed -- coarse stage-by-stage progress for a command that talks to a real network. */
  private progress(msg: string): void {
    console.log(msg);
  }

  /** Verbose-only -- finer detail (one line per real page fetch), noisy for a large database. */
  private log(msg: string): void {
    if (this.opts.verbose) console.log(msg);
  }

  private async fetchMeta(client: RqliteHttpClient, targetDbId: string | undefined): Promise<Meta> {
    const extra = targetDbId ? { target_db_id: targetDbId } : {};
    const row = resultRows(await client.query("GET_META", [{}], extra))[0];
    if (!row) throw new Error("GET_META returned no row -- has this account committed a db yet?");
    return { currentVersion: Number(row[0]), pageCount: Number(row[1]), pageSize: Number(row[2]) };
  }

  private async startWorker(
    creds: PerfCreds,
    targetDbId: string | undefined,
    meta: Meta,
  ): Promise<Bridge> {
    const controlSab = new SharedArrayBuffer(8);
    const dataSab = new SharedArrayBuffer(Math.max(meta.pageSize, 4096) + 4096);
    const control = new Int32Array(controlSab);
    const dataBuf = new Uint8Array(dataSab);
    const worker = new Worker(new URL("./remotePageWorker.ts", import.meta.url), {
      workerData: {
        rqliteUrl: creds.rqlite_url,
        apiKey: creds.api_key,
        targetDbId,
        snapshot: meta.currentVersion,
        controlSab,
        dataSab,
      },
    });
    await waitReady(worker);
    return {
      fetchPage: (pageNo) => this.fetchPageAndLog(worker, control, dataBuf, pageNo),
      terminate: () => worker.terminate().then(() => undefined),
    };
  }

  private fetchPageAndLog(
    worker: Worker,
    control: Int32Array,
    dataBuf: Uint8Array,
    pageNo: number,
  ): Uint8Array {
    const start = performance.now();
    const bytes = fetchPageSync(worker, control, dataBuf, pageNo);
    this.log(
      `  fetched page ${pageNo} (${bytes.length}b, ${(performance.now() - start).toFixed(1)}ms)`,
    );
    return bytes;
  }

  private runQueries(db: SqliteDb, stats: RemoteVfsStats): QueryReport[] {
    this.progress("\n--- --test-perf report ---");
    return DEFAULT_QUERIES.map((sql, i) => this.runOneQuery(db, stats, sql, i));
  }

  private runOneQuery(
    db: SqliteDb,
    stats: RemoteVfsStats,
    sql: string,
    index: number,
  ): QueryReport {
    this.progress(`[${index + 1}/${DEFAULT_QUERIES.length}] ${sql}`);
    const before = stats.roundtrips.length;
    const start = performance.now();
    const rows = execSelect(db, sql);
    const ms = performance.now() - start;
    const report = { sql, rows, ms, roundtrips: stats.roundtrips.length - before };
    this.progress(`  rows=${report.rows} roundtrips=${report.roundtrips} time=${ms.toFixed(1)}ms`);
    return report;
  }
}

function execSelect(db: SqliteDb, sql: string): number {
  const stmt = db.prepare(sql);
  let rows = 0;
  while (stmt.step()) rows++;
  stmt.finalize();
  return rows;
}

function waitReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("message", (msg: { type?: string }) => {
      if (msg?.type === "ready") resolve();
      else reject(new Error("unexpected first message from remote-page worker"));
    });
    worker.once("error", reject);
  });
}

function fetchPageSync(
  worker: Worker,
  control: Int32Array,
  dataBuf: Uint8Array,
  pageNo: number,
): Uint8Array {
  Atomics.store(control, CONTROL_STATUS, 0);
  worker.postMessage({ pageNo });
  if (Atomics.wait(control, CONTROL_STATUS, 0, FETCH_TIMEOUT_MS) === "timed-out") {
    throw new Error(`timed out fetching page ${pageNo}`);
  }
  const status = Atomics.load(control, CONTROL_STATUS);
  const bytes = dataBuf.slice(0, Atomics.load(control, CONTROL_LEN));
  if (status === STATUS_ERROR) throw new Error(Buffer.from(bytes).toString("utf8"));
  return bytes;
}

function printSummary(reports: QueryReport[], stats: RemoteVfsStats): void {
  const totalMs = reports.reduce((a, r) => a + r.ms, 0);
  const rtMs = stats.roundtrips.map((r) => r.ms);
  const sum = rtMs.reduce((a, b) => a + b, 0);
  console.log(`\ntotal query time: ${totalMs.toFixed(1)}ms across ${reports.length} queries`);
  console.log(`total roundtrips: ${stats.roundtrips.length} (distinct pages fetched)`);
  console.log(`bytes fetched: ${stats.bytesFetched}`);
  if (rtMs.length === 0) return;
  const avg = sum / rtMs.length;
  console.log(
    `roundtrip time: total=${sum.toFixed(1)}ms avg=${avg.toFixed(1)}ms ` +
      `min=${Math.min(...rtMs).toFixed(1)}ms max=${Math.max(...rtMs).toFixed(1)}ms`,
  );
}

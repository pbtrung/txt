// Wraps the D1 binding so every query prints to the Worker's own console
// (`wrangler tail` in production, stdout in `worker:dev`/`worker:test`)
// and contributes to this request's D1 wait time (summed by index.ts into
// its "Worker wait time" log line, worker/requestTiming.ts) -- D1 wait,
// like any I/O wait, isn't part of what Cloudflare bills as CPU time.
// Applied once, in worker/index.ts before `env` ever reaches handleApi(),
// so every existing and future call site across worker/*Endpoint.ts gets
// this for free without being touched individually.
//
// Every method here measures its own real wall-clock time directly
// (performance.now(), stored as D1QueryLog.durationMs) rather than
// trusting D1's own self-reported meta.duration for the wait-time
// aggregate: meta.duration reflects D1's own query-execution accounting
// (there's a separate, narrower meta.timings.sql_duration_ms explicitly
// documented as excluding network time, implying the top-level duration
// field's scope is its own thing, not "everything this await cost") and
// empirically undercounts the actual round trip a real deployed request
// experiences -- confirmed against real logs showing 30-38ms of "CPU
// time" next to a near-zero summed meta.duration for endpoints that only
// ever do one simple query. meta.duration is still recorded and logged
// as d1ReportedMs, purely as informational D1-reported context.
//
// first()/raw() never return a D1Result/meta at all (confirmed against
// @cloudflare/workers-types), so rowsRead/rowsWritten/changes/lastRowId/
// d1ReportedMs are null for those two -- but they still make a real D1
// round trip, so their measured wall-clock duration counts the same as
// any other query's wait time. Almost every endpoint calls first() for
// its single-row lookup, so leaving it unmeasured (as an earlier version
// of this file did) misattributed most of this app's actual D1 wait time
// to CPU time.
//
// exec()/withSession()/dump() are declared for completeness but unused
// anywhere in this codebase (grepped) -- they pass through unwrapped too.
import { formatMs } from "./formatMs";

const REAL = Symbol("real D1PreparedStatement");

interface LoggedStatement extends D1PreparedStatement {
  [REAL]: { statement: D1PreparedStatement; sql: string };
}

export interface D1QueryLog {
  sql: string;
  durationMs: number;
  // meta.duration, informational only -- null for first()/raw(), which
  // never return a D1Meta to read it from.
  d1ReportedMs: number | null;
  rowsRead: number | null;
  rowsWritten: number | null;
  changes: number | null;
  lastRowId: number | null;
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}

function record(entry: D1QueryLog, queries: D1QueryLog[]): void {
  queries.push(entry);
  console.log(
    "D1 query:",
    JSON.stringify({
      sql: entry.sql,
      duration_ms: formatMs(entry.durationMs),
      d1_reported_ms: entry.d1ReportedMs === null ? null : formatMs(entry.d1ReportedMs),
      rows_read: entry.rowsRead,
      rows_written: entry.rowsWritten,
      changes: entry.changes,
      last_row_id: entry.lastRowId,
    }),
  );
}

async function timeUnmetered(
  sql: string,
  queries: D1QueryLog[],
  call: () => Promise<unknown>,
): Promise<unknown> {
  const start = performance.now();
  const result = await call();
  record(
    {
      sql: normalizeSql(sql),
      durationMs: performance.now() - start,
      d1ReportedMs: null,
      rowsRead: null,
      rowsWritten: null,
      changes: null,
      lastRowId: null,
    },
    queries,
  );
  return result;
}

async function timeMetered<T extends { meta: D1Meta }>(
  sql: string,
  queries: D1QueryLog[],
  call: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await call();
  record(
    {
      sql: normalizeSql(sql),
      durationMs: performance.now() - start,
      d1ReportedMs: result.meta.duration,
      rowsRead: result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
      changes: result.meta.changes,
      lastRowId: result.meta.last_row_id,
    },
    queries,
  );
  return result;
}

function wrapStatement(
  statement: D1PreparedStatement,
  sql: string,
  queries: D1QueryLog[],
): LoggedStatement {
  return {
    [REAL]: { statement, sql },
    bind: (...values: unknown[]) =>
      wrapStatement(statement.bind(...values), sql, queries),
    first: ((...args: unknown[]) =>
      timeUnmetered(sql, queries, () =>
        (statement.first as (...a: unknown[]) => Promise<unknown>)(...args),
      )) as D1PreparedStatement["first"],
    raw: ((options?: { columnNames?: boolean }) =>
      timeUnmetered(sql, queries, () =>
        (statement.raw as (o?: { columnNames?: boolean }) => Promise<unknown>)(options),
      )) as D1PreparedStatement["raw"],
    run: <T = Record<string, unknown>>() =>
      timeMetered(sql, queries, () => statement.run<T>()),
    all: <T = Record<string, unknown>>() =>
      timeMetered(sql, queries, () => statement.all<T>()),
  };
}

// batch() receives statements this same wrapper minted via prepare() below
// -- every env.DB access in this codebase goes through the one wrapped
// binding index.ts installs, so a LoggedStatement's hidden REAL entry is
// always present. Unwrapping back to the real statement (rather than
// handing the runtime our wrapper object) is what lets batch() itself
// stay a thin pass-through to the real D1Database.batch().
//
// The whole batch is one round trip, so only the first result's log entry
// carries the measured wall-clock duration; the rest record 0 for it (but
// still their own real d1ReportedMs/rows from D1's own per-statement
// meta) -- otherwise index.ts summing every entry's durationMs would
// multiply one batch's wait time by its statement count.
//
// `queries` is a plain array supplied by the caller (one per request,
// index.ts) rather than module-level state: a Worker isolate can be
// handling several concurrent requests at once, and a shared array would
// mix one request's queries into another's totals.
export function withD1QueryLogging(db: D1Database, queries: D1QueryLog[]): D1Database {
  return {
    prepare: (query) => wrapStatement(db.prepare(query), query, queries),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const entries = statements.map(
        (statement) => (statement as LoggedStatement)[REAL],
      );
      const start = performance.now();
      const results = await db.batch<T>(entries.map((entry) => entry.statement));
      const batchMs = performance.now() - start;
      results.forEach((result, index) => {
        record(
          {
            sql: normalizeSql(entries[index].sql),
            durationMs: index === 0 ? batchMs : 0,
            d1ReportedMs: result.meta.duration,
            rowsRead: result.meta.rows_read,
            rowsWritten: result.meta.rows_written,
            changes: result.meta.changes,
            lastRowId: result.meta.last_row_id,
          },
          queries,
        );
      });
      return results;
    },
    exec: (query) => db.exec(query),
    withSession: (constraintOrBookmark) => db.withSession(constraintOrBookmark),
    dump: () => db.dump(),
  };
}

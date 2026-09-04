// Wraps the D1 binding so every query's own `meta` -- rows_read,
// rows_written, duration, and friends, the D1 HTTP API's documented
// response shape -- prints to the Worker's own console: `wrangler tail`
// in production, stdout in `worker:dev`/`worker:test`. Applied once, in
// worker/index.ts before `env` ever reaches handleApi(), so every
// existing and future call site across worker/*Endpoint.ts gets this for
// free without being touched individually. index.ts also sums every
// entry's own duration to get this request's total D1 wait time, folded
// into its "Worker wait time" log line (worker/requestTiming.ts) -- D1
// wait, like any I/O wait, isn't part of what Cloudflare bills as CPU
// time.
//
// first()/raw() never return a D1Result at all (confirmed against
// @cloudflare/workers-types' D1PreparedStatement), so there's no
// rows_read/rows_written to report for either -- but both still make a
// real D1 round trip, so their wall-clock duration is measured directly
// (performance.now(), not D1's own meta) and counted the same as any
// other query's wait time. Almost every endpoint calls first() (a single-
// row lookup), so leaving it unmeasured would misattribute most of this
// app's actual D1 wait time to CPU time -- confirmed against a real
// GET /v1/catalog log line showing 0.00ms of D1 wait next to a highly
// implausible 52ms of "CPU time" (Workers' own free-tier limit is 10ms),
// before this fix.
//
// exec()/withSession()/dump() are declared for completeness but unused
// anywhere in this codebase (grepped) -- they pass through unwrapped too.

const REAL = Symbol("real D1PreparedStatement");

interface LoggedStatement extends D1PreparedStatement {
  [REAL]: { statement: D1PreparedStatement; sql: string };
}

export interface D1QueryLog {
  sql: string;
  durationMs: number;
  // null for first()/raw(), which never return a D1Meta to read these from.
  rowsRead: number | null;
  rowsWritten: number | null;
  changes: number | null;
  lastRowId: number | null;
}

function fromMeta(sql: string, meta: D1Meta): D1QueryLog {
  return {
    sql: sql.trim().replace(/\s+/g, " "),
    durationMs: meta.duration,
    rowsRead: meta.rows_read,
    rowsWritten: meta.rows_written,
    changes: meta.changes,
    lastRowId: meta.last_row_id,
  };
}

function fromDuration(sql: string, durationMs: number): D1QueryLog {
  return {
    sql: sql.trim().replace(/\s+/g, " "),
    durationMs,
    rowsRead: null,
    rowsWritten: null,
    changes: null,
    lastRowId: null,
  };
}

function record(entry: D1QueryLog, queries: D1QueryLog[]): void {
  queries.push(entry);
  console.log(
    "D1 query:",
    JSON.stringify({
      sql: entry.sql,
      duration_ms: entry.durationMs.toFixed(2),
      rows_read: entry.rowsRead,
      rows_written: entry.rowsWritten,
      changes: entry.changes,
      last_row_id: entry.lastRowId,
    }),
  );
}

async function timeCall<T>(
  sql: string,
  queries: D1QueryLog[],
  call: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await call();
  record(fromDuration(sql, performance.now() - start), queries);
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
      timeCall(sql, queries, () =>
        (statement.first as (...a: unknown[]) => Promise<unknown>)(...args),
      )) as D1PreparedStatement["first"],
    raw: ((options?: { columnNames?: boolean }) =>
      timeCall(sql, queries, () =>
        (statement.raw as (o?: { columnNames?: boolean }) => Promise<unknown>)(options),
      )) as D1PreparedStatement["raw"],
    run: async <T = Record<string, unknown>>() => {
      const result = await statement.run<T>();
      record(fromMeta(sql, result.meta), queries);
      return result;
    },
    all: async <T = Record<string, unknown>>() => {
      const result = await statement.all<T>();
      record(fromMeta(sql, result.meta), queries);
      return result;
    },
  };
}

// batch() receives statements this same wrapper minted via prepare() below
// -- every env.DB access in this codebase goes through the one wrapped
// binding index.ts installs, so a LoggedStatement's hidden REAL entry is
// always present. Unwrapping back to the real statement (rather than
// handing the runtime our wrapper object) is what lets batch() itself
// stay a thin pass-through to the real D1Database.batch().
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
      const results = await db.batch<T>(entries.map((entry) => entry.statement));
      results.forEach((result, index) =>
        record(fromMeta(entries[index].sql, result.meta), queries),
      );
      return results;
    },
    exec: (query) => db.exec(query),
    withSession: (constraintOrBookmark) => db.withSession(constraintOrBookmark),
    dump: () => db.dump(),
  };
}

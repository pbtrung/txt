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
// @cloudflare/workers-types' D1PreparedStatement) -- there is no meta to
// log for either, so both pass straight through to the real statement.
// exec()/withSession()/dump() are declared for completeness but unused
// anywhere in this codebase (grepped) -- they pass through unwrapped too.

const REAL = Symbol("real D1PreparedStatement");

interface LoggedStatement extends D1PreparedStatement {
  [REAL]: { statement: D1PreparedStatement; sql: string };
}

export interface D1QueryLog {
  sql: string;
  durationMs: number;
  rows_read: number;
  rows_written: number;
  changes: number;
  last_row_id: number;
}

function toQueryLog(sql: string, meta: D1Meta): D1QueryLog {
  return {
    sql: sql.trim().replace(/\s+/g, " "),
    durationMs: meta.duration,
    rows_read: meta.rows_read,
    rows_written: meta.rows_written,
    changes: meta.changes,
    last_row_id: meta.last_row_id,
  };
}

function logMeta(sql: string, meta: D1Meta, queries: D1QueryLog[]): void {
  const entry = toQueryLog(sql, meta);
  queries.push(entry);
  const { durationMs, ...rest } = entry;
  console.log(
    "D1 query:",
    JSON.stringify({ ...rest, duration_ms: durationMs.toFixed(2) }),
  );
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
    first: statement.first.bind(statement),
    raw: statement.raw.bind(statement),
    run: async <T = Record<string, unknown>>() => {
      const result = await statement.run<T>();
      logMeta(sql, result.meta, queries);
      return result;
    },
    all: async <T = Record<string, unknown>>() => {
      const result = await statement.all<T>();
      logMeta(sql, result.meta, queries);
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
        logMeta(entries[index].sql, result.meta, queries),
      );
      return results;
    },
    exec: (query) => db.exec(query),
    withSession: (constraintOrBookmark) => db.withSession(constraintOrBookmark),
    dump: () => db.dump(),
  };
}

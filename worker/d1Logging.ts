// Wraps the D1 binding so every query's own `meta` -- rows_read,
// rows_written, duration, and friends, the D1 HTTP API's documented
// response shape -- prints to the Worker's own console: `wrangler tail`
// in production, stdout in `worker:dev`/`worker:test`. Applied once, in
// worker/index.ts before `env` ever reaches handleApi(), so every
// existing and future call site across worker/*Endpoint.ts gets this for
// free without being touched individually. index.ts also collects the
// same entries into the request's `X-D1-Meta` response header, since the
// browser has no D1 access of its own to log this from
// (docs/data_model.md: "Nothing proxies raw SQL to a client") --
// ui/src/data/d1MetaLog.ts prints that header to the browser console.
//
// first()/raw() never return a D1Result at all (confirmed against
// @cloudflare/workers-types' D1PreparedStatement) -- there is no meta to
// log for either, so both pass straight through to the real statement.
// exec()/withSession()/dump() are declared for completeness but unused
// anywhere in this codebase (grepped) -- they pass through unwrapped too.

// Mirrored as a literal in ui/src/data/d1MetaLog.ts, which has no way to
// import this module (a separate browser build) -- keep both in sync by
// hand if this ever changes.
export const D1_META_HEADER = "X-D1-Meta";

const REAL = Symbol("real D1PreparedStatement");

interface LoggedStatement extends D1PreparedStatement {
  [REAL]: { statement: D1PreparedStatement; sql: string };
}

export interface D1QueryLog {
  sql: string;
  duration_ms: number;
  rows_read: number;
  rows_written: number;
  changes: number;
  last_row_id: number;
}

function toQueryLog(sql: string, meta: D1Meta): D1QueryLog {
  return {
    sql: sql.trim().replace(/\s+/g, " "),
    duration_ms: meta.duration,
    rows_read: meta.rows_read,
    rows_written: meta.rows_written,
    changes: meta.changes,
    last_row_id: meta.last_row_id,
  };
}

function logMeta(sql: string, meta: D1Meta, queries: D1QueryLog[]): void {
  const entry = toQueryLog(sql, meta);
  queries.push(entry);
  console.log("D1 query:", JSON.stringify(entry));
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
// mix one request's queries into another's response header.
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

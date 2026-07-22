// Turso connection, mirrors txt/db.py's Database -- but there's no schema
// application here (that's the admin CLI's job via --init) and this always
// uses @libsql/client's "web" build: a fetch/WebSocket-based Hrana client
// with no native bindings, safe in both the browser and Node/Vitest (the
// package's default "." export pulls in a native `libsql` binding on Node,
// which we never want here).

import { createClient } from "@libsql/client/web";
import type { Client, InArgs, InStatement, Value } from "@libsql/core/api";

import { verbose } from "../log";
import type { Creds } from "./creds";

/** Renders whichever execute() overload was used (bare SQL string, or an
 * {sql, args} statement object) into one line for verbose logging. */
function describeExecuteCall(stmtOrSql: InStatement | string, args?: InArgs): string {
  if (typeof stmtOrSql === "string") {
    return args === undefined ? stmtOrSql : `${stmtOrSql} ${JSON.stringify(args)}`;
  }
  return stmtOrSql.args === undefined ? stmtOrSql.sql : `${stmtOrSql.sql} ${JSON.stringify(stmtOrSql.args)}`;
}

/** Wraps every db.execute() call with verbose logging (see src/log.ts) --
 * every screen's data layer (owner.ts, metadata.ts, perUserBlob.ts, ...)
 * goes through this same client instance, so this is the one place that
 * needs to know about logging rather than every call site. */
function withRequestLogging(client: Client): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "execute") {
        // Bound to target, not the proxy (receiver) -- the real client's
        // other methods may rely on `this` internally, which method-call
        // syntax (db.close()) would otherwise bind to this proxy instead.
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (stmtOrSql: InStatement | string, args?: InArgs) => {
        const description = describeExecuteCall(stmtOrSql, args);
        verbose(`db.execute: ${description}`);
        try {
          const result =
            typeof stmtOrSql === "string" ? await target.execute(stmtOrSql, args) : await target.execute(stmtOrSql);
          verbose(`db.execute done: ${description} -> ${result.rows.length} row(s)`);
          return result;
        } catch (err) {
          verbose(`db.execute failed: ${description}`, err);
          throw err;
        }
      };
    },
  });
}

export function createDb(creds: Creds): Client {
  const client = createClient({ url: creds.tursoDatabaseUrl, authToken: creds.tursoAuthToken });
  return withRequestLogging(client);
}

/** A BLOB column comes back as ArrayBuffer|null; this gets it into the Uint8Array our crypto layer expects. */
function blobToBytes(value: Value | null | undefined): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`expected a BLOB column, got ${typeof value}`);
}

/** Same as blobToBytes but throws instead of returning null -- for columns that must be present. */
export function requireBlobBytes(value: Value | null | undefined, what: string): Uint8Array {
  const bytes = blobToBytes(value);
  if (bytes === null) {
    throw new Error(`${what}: expected a BLOB column, got null`);
  }
  return bytes;
}

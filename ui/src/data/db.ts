// Turso connection, mirrors txt/db.py's Database -- but there's no schema
// application here (that's the admin CLI's job via --init) and this always
// uses @libsql/client's "web" build: a fetch/WebSocket-based Hrana client
// with no native bindings, safe in both the browser and Node/Vitest (the
// package's default "." export pulls in a native `libsql` binding on Node,
// which we never want here).

import { createClient } from "@libsql/client/web";
import type { Client, Value } from "@libsql/core/api";

import type { Creds } from "./creds";

export function createDb(creds: Creds): Client {
  return createClient({ url: creds.tursoDatabaseUrl, authToken: creds.tursoAuthToken });
}

/** A BLOB column comes back as ArrayBuffer|null; this gets it into the Uint8Array our crypto layer expects. */
export function blobToBytes(value: Value | null | undefined): Uint8Array | null {
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

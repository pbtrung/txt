// Ports the AA key-unwrap chain exactly (txt/account_session.py,
// txt/init_db.py, txt/ingest.py's own read side): user_root_key -> decrypt
// key_store.umk -> decrypt meta.db_prefix / cred_store.content (JSON) /
// library_index's object_key+lib_idx_key / the active bundle's
// bundle_key+bundle_enc_key. Takes a minimal `{query}` interface rather
// than the concrete LibsqlClient class, so tests can pass a fake AA without
// a real Turso connection.
import { decrypt, decryptJson } from "../crypto/cryptoBlob";
import type { CellValue } from "./libsql";

export interface Aa {
  query(sql: string, args?: (Uint8Array | number | string)[]): Promise<CellValue[][]>;
}

export type AccountType = "admin" | "user";

export interface CredStorePayload {
  user_id: string;
  display_name: string;
  db_master_key: string;
  db_prefix: string;
}

export interface LibraryIndexKeys {
  objectKey: string;
  libIdxKey: Uint8Array;
}

export interface BundleKeys {
  bundleKey: string;
  bundleEncKey: Uint8Array;
}

function asBytes(value: CellValue): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("expected a BLOB cell");
  return value;
}

export async function readUmk(aa: Aa, ikm: Uint8Array): Promise<Uint8Array | null> {
  const rows = await aa.query("SELECT umk FROM key_store WHERE id = 1");
  return rows.length === 0 ? null : decrypt(asBytes(rows[0][0]), ikm);
}

export async function readDbPrefix(aa: Aa, umk: Uint8Array): Promise<string> {
  const rows = await aa.query("SELECT db_prefix FROM meta WHERE id = 1");
  if (rows.length === 0) throw new Error("meta row missing; run --init-db first");
  return new TextDecoder().decode(await decrypt(asBytes(rows[0][0]), umk));
}

function credStoreQuery(accountType: AccountType, uid: string): [string, (Uint8Array | number | string)[]] {
  return accountType === "admin"
    ? ["SELECT content FROM cred_store WHERE user_id = ?", [uid]]
    : ["SELECT content FROM cred_store WHERE id = 1", []];
}

export async function readCredStore(aa: Aa, umk: Uint8Array, accountType: AccountType, uid: string): Promise<CredStorePayload> {
  const [sql, args] = credStoreQuery(accountType, uid);
  const rows = await aa.query(sql, args);
  if (rows.length === 0) throw new Error("cred_store row missing; run --init-db first");
  return decryptJson<CredStorePayload>(asBytes(rows[0][0]), umk);
}

export async function readLibraryIndexKeys(aa: Aa, umk: Uint8Array): Promise<LibraryIndexKeys | null> {
  const rows = await aa.query("SELECT object_key, lib_idx_key FROM library_index WHERE id = 1");
  if (rows.length === 0) return null;
  const [objectKey, libIdxKey] = rows[0];
  return {
    objectKey: new TextDecoder().decode(await decrypt(asBytes(objectKey), umk)),
    libIdxKey: await decrypt(asBytes(libIdxKey), umk),
  };
}

export async function readActiveBundleKeys(aa: Aa, umk: Uint8Array): Promise<BundleKeys | null> {
  const rows = await aa.query("SELECT bundle_key, bundle_enc_key FROM bundles WHERE retired_at IS NULL");
  if (rows.length === 0) return null;
  const [bundleKey, bundleEncKeyWrapped] = rows[0];
  const bundleEncKey = await decrypt(asBytes(bundleEncKeyWrapped), umk);
  return { bundleKey: new TextDecoder().decode(await decrypt(asBytes(bundleKey), bundleEncKey)), bundleEncKey };
}

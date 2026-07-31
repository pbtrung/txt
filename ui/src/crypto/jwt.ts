// Turso auth tokens are JWTs (docs/credentials.md's "Turso token scope: fine-
// grained, per-table permissions"). This only ever reads the payload's
// claims -- no signature verification, since the point isn't to authenticate
// the token (Turso itself does that when a query runs), just to tell an
// admin-shaped token from a regular-user one so the Manage screen can gate
// itself, mirroring credentials.md's "How a client knows its own role":
// that's a client-local, load-time fact, never something looked up from the
// database.

/** Decodes a JWT's payload (the middle, base64url segment) into JSON --
 * no signature check, just reading claims. Throws if `token` isn't shaped
 * like a JWT at all. */
export function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("not a JWT: expected at least 2 dot-separated segments");
  }
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const json = atob(padded);
  return JSON.parse(json);
}

interface TursoTokenPerm {
  t: string | null;
  a: unknown;
}

// The exact verb set an admin token's single, all-tables permission entry
// must carry -- every data and schema verb Turso's fine-grained permission
// system offers (docs/credentials.md's "Minting each role's token").
const ADMIN_VERBS = [
  "data_read",
  "data_add",
  "data_update",
  "data_delete",
  "schema_add",
  "schema_update",
  "schema_delete",
];

/** True only for the exact admin token shape: a single `perm` entry with
 * `t: null` (every table) and `a` containing exactly the 7 admin verbs --
 * not "has schema_delete somewhere," a strict structural match, so a
 * regular user's multi-entry, mostly-data_read token never passes. Returns
 * false (never throws) for anything malformed. */
export function isAdminToken(token: string): boolean {
  try {
    const payload = decodeJwtPayload(token) as { perm?: unknown };
    const perm = payload.perm;
    if (!Array.isArray(perm) || perm.length !== 1) return false;
    const entry = perm[0] as TursoTokenPerm;
    if (entry.t !== null) return false;
    if (!Array.isArray(entry.a)) return false;
    const verbs = new Set(entry.a);
    return verbs.size === ADMIN_VERBS.length && ADMIN_VERBS.every((v) => verbs.has(v));
  } catch {
    return false;
  }
}

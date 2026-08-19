// docs/auth.md §2/§5 step 2: the ctl join returning wrapped key material,
// the server-authoritative path binding, and the wrapped cred_store backup
// for one uid over libsql's HTTP pipeline protocol.

const LOOKUP_SQL =
  "SELECT u.type, k.umk, k.sign_version, k.sign_algorithm, " +
  "k.sign_pubkey, k.sign_privkey, u.user_handle_hash, u.db_binding_hash, " +
  "c.content FROM users u " +
  "JOIN key_store k ON k.user_id = u.id " +
  "JOIN cred_store c ON c.owner_id = u.id AND c.for_user_id = u.id " +
  "WHERE u.id = ?";

export type AccountType = "admin" | "user";

export interface Account {
  type: AccountType;
  umk: string; // base64
  signVersion: number;
  signAlgorithm: string;
  signPublicKey: string; // base64 SPKI DER
  signPrivateKey: string; // base64 encrypted PKCS#8 DER
  userHandleHash: string; // base64 SHA-256 digest
  dbBindingHash: string; // base64 SHA-512 digest
  credStoreContent: string; // base64
}

interface Cell {
  type: string;
  value?: string;
  base64?: string;
}

interface PipelineResponse {
  results: Array<{ response: { result: { rows: Cell[][] } } }>;
}

export async function lookupAccount(
  ctlDbUrl: string,
  ctlDbToken: string,
  uid: string,
): Promise<Account | null> {
  const rows = await queryUsers(ctlDbUrl, ctlDbToken, uid);
  return rows.length === 0 ? null : rowToAccount(rows[0]);
}

async function queryUsers(
  ctlDbUrl: string,
  ctlDbToken: string,
  uid: string,
): Promise<Cell[][]> {
  const base = ctlDbUrl.replace("libsql://", "https://");
  const body = {
    requests: [
      {
        type: "execute",
        stmt: { sql: LOOKUP_SQL, args: [{ type: "text", value: uid }] },
      },
      { type: "close" },
    ],
  };
  const resp = await fetch(`${base}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctlDbToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`ctl query failed: ${resp.status}`);
  const data = (await resp.json()) as PipelineResponse;
  return data.results[0].response.result.rows;
}

function rowToAccount([
  typeCell,
  umkCell,
  signVersionCell,
  signAlgorithmCell,
  signPublicKeyCell,
  signPrivateKeyCell,
  userHandleHashCell,
  dbBindingHashCell,
  contentCell,
]: Cell[]): Account {
  const type = cellText(typeCell);
  if (type !== "admin" && type !== "user") {
    throw new Error(`invalid account type: ${type}`);
  }
  return {
    type,
    umk: cellBase64(umkCell),
    signVersion: cellInteger(signVersionCell),
    signAlgorithm: cellText(signAlgorithmCell),
    signPublicKey: cellBase64(signPublicKeyCell),
    signPrivateKey: cellBase64(signPrivateKeyCell),
    userHandleHash: cellBase64(userHandleHashCell),
    dbBindingHash: cellBase64(dbBindingHashCell),
    credStoreContent: cellBase64(contentCell),
  };
}

function cellInteger(cell: Cell): number {
  if (cell.type !== "integer" || cell.value === undefined) {
    throw new Error(`expected an integer cell, got ${cell.type}`);
  }
  const value = Number(cell.value);
  if (!Number.isSafeInteger(value)) throw new Error("integer cell is out of range");
  return value;
}

function cellText(cell: Cell): string {
  if (cell.type !== "text" || cell.value === undefined) {
    throw new Error(`expected a text cell, got ${cell.type}`);
  }
  return cell.value;
}

function cellBase64(cell: Cell): string {
  if (cell.type !== "blob" || cell.base64 === undefined) {
    throw new Error(`expected a blob cell, got ${cell.type}`);
  }
  return cell.base64;
}

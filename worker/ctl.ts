// docs/auth.md §2/§5 step 2: the ctl join returning identity, wrapped key
// material, and the wrapped cred_store backup for one uid, over the same
// libsql HTTP /v2/pipeline protocol txt/libsql_client.py uses server-side.
// The query selects pubkey/privkey too, matching docs/auth.md §2's own
// example exactly, even though no Worker endpoint forwards them onward.

const LOOKUP_SQL =
  "SELECT u.type, k.umk, k.pubkey, k.privkey, c.content FROM users u " +
  "JOIN key_store k ON k.user_id = u.id " +
  "JOIN cred_store c ON c.owner_id = u.id AND c.for_user_id = u.id " +
  "WHERE u.id = ?";

export type AccountType = "admin" | "user";

export interface Account {
  type: AccountType;
  umk: string; // base64
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

function rowToAccount([typeCell, umkCell, , , contentCell]: Cell[]): Account {
  return {
    type: cellText(typeCell) as AccountType,
    umk: cellBase64(umkCell),
    credStoreContent: cellBase64(contentCell),
  };
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

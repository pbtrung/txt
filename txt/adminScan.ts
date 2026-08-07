// Shared by --collect-garbage and --clean-bucket: resolves the admin
// account's identity directly against InstantDB via the Admin SDK (auth.id,
// unwrapped umk, a read-write R2 client from its own credStore row), and
// every document (`txt` row) it owns with each part's own decrypted
// raw_key. Both callers start from exactly this same question -- which R2
// objects does InstantDB currently know about for this account -- and only
// differ in what they do with the answer (collectGarbage.ts sweeps each
// document's own prefix; bucket.ts sweeps the whole bucket against the
// union of every document's known paths).
import { loadReadWriteR2Config, type R2ConfigResolved } from "./creds.ts";
import type { CryptoEngine } from "./crypto.ts";
import type { GcCreds } from "./gcCreds.ts";
import * as C from "./constants.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import type { OrphanSweepTarget } from "./orphanSweep.ts";
import { unwrapToken } from "./randomToken.ts";
import { R2Client } from "./r2.ts";

export interface AdminIdentity {
  authId: string;
  umk: Buffer;
  r2: R2Client;
}

// Finds the one $users row (type: "admin") whose umk actually decrypts
// under this creds.json's own user_root_key -- there's no other way to
// know which admin row it belongs to without trying each candidate (AEAD
// tag verification fails hard on a wrong key, so this is safe: exactly
// one candidate can ever succeed). Then unwraps that account's own
// admin credential row for the read-write r2_config used by every R2
// operation below, since only the admin ever owns content.
export async function resolveAdmin(
  db: any,
  crypto: CryptoEngine,
  creds: GcCreds,
  log: Logger,
): Promise<AdminIdentity> {
  const result = await db.query({
    $users: { $: { where: { type: "admin" } } },
  });
  const candidates = result.$users ?? [];
  for (const row of candidates) {
    let umk: Buffer;
    try {
      umk = crypto.blobDecrypt(
        creds.userRootKey,
        Buffer.from(row.umk, "base64"),
        false,
      );
    } catch {
      // Wrong admin candidate for this user_root_key -- try the next one.
      continue;
    }
    const r2Config = await resolveOwnCredStore(db, crypto, row.id, umk, log);
    log.info(`Resolved admin identity: auth.id=${row.id}`);
    return {
      authId: row.id,
      umk,
      r2: new R2Client(r2Config, false, log),
    };
  }
  throw new Error(
    `no admin $users row's umk decrypts under this creds.json's user_root_key ` +
      `(tried ${candidates.length} candidate(s))`,
  );
}

// The admin's owner link on credStore is not unique: it includes the
// admin's own self row and admin-owned recovery rows for users. Recovery
// rows are intentionally missing static R2 keys, so scan for the row whose
// decrypted content has a read-write r2_config instead of taking the first.
async function resolveOwnCredStore(
  db: any,
  crypto: CryptoEngine,
  ownerId: string,
  umk: Buffer,
  log: Logger,
): Promise<R2ConfigResolved> {
  const result = await db.query({
    credStore: { $: { where: { "owner.id": ownerId } } },
  });
  const rows = result.credStore ?? [];
  for (const row of rows) {
    try {
      const credStoreKey = crypto.blobDecrypt(
        umk,
        Buffer.from(row.credStoreKey, "base64"),
        false,
      );
      const payload = JSON.parse(
        crypto
          .blobDecrypt(credStoreKey, Buffer.from(row.content, "base64"), true)
          .toString("utf8"),
      );
      return loadReadWriteR2Config(payload);
    } catch (err) {
      log.debug(
        `Skipping admin-owned credStore row without read-write R2 config: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new Error(
    `no admin-owned credStore row with read-write r2_config for auth.id=${ownerId}`,
  );
}

// Every document (`txt` row) this admin owns, with every one of its own
// parts' raw_key already decrypted -- paginated (order by sourceTxtId --
// an entity's own built-in `id` is NOT usable in an InstaQL `order`
// clause, confirmed against a real InstantDB app: "The `txt.id` attribute
// is not indexed"/"not typed. Only indexed and typed attributes can be
// used to order by." sourceTxtId is indexed and, today, set on every txt
// row -- only --migrate ever creates one) rather than one unpaginated
// query, since a large corpus risks exceeding InstantDB's own query
// timeout otherwise.
export async function resolveOwnedDocuments(
  db: any,
  crypto: CryptoEngine,
  admin: AdminIdentity,
  log: Logger,
): Promise<OrphanSweepTarget[]> {
  const rows = await collectAllPages<{
    id: string;
    txtKey: string;
    prefix: string;
    txtParts: { txtPartKey: string; path: string }[];
  }>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.query({
      txt: {
        $: {
          where: { "owner.id": admin.authId },
          order: { sourceTxtId: "asc" },
          limit: C.INSTAQL_QUERY_PAGE_SIZE,
          offset,
        },
        txtParts: {},
      },
    });
    const page = result.txt ?? [];
    log.info(`Fetched ${offset + page.length} txt row(s) so far...`);
    return {
      rows: page,
      hasNextPage: page.length === C.INSTAQL_QUERY_PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });
  return rows.map((row) => {
    const txtKey = crypto.blobDecrypt(
      admin.umk,
      Buffer.from(row.txtKey, "base64"),
      false,
    );
    const prefix = unwrapToken(crypto, txtKey, row.prefix);
    const knownRawKeys = new Set(
      (row.txtParts ?? []).map((p) => {
        const txtPartKey = crypto.blobDecrypt(
          txtKey,
          Buffer.from(p.txtPartKey, "base64"),
          false,
        );
        return unwrapToken(crypto, txtPartKey, p.path);
      }),
    );
    return { label: `txt=${row.id}`, prefix, knownRawKeys };
  });
}

// Orchestrator for --clean-bucket: deletes every R2 object not referenced by
// any admin-owned txtParts row currently in InstantDB. This lists the whole
// bucket once and diffs it against the union of every owned document's own
// known raw_paths -- the tool for "is there anything at all left in this
// bucket that InstantDB doesn't know about," not scoped to any one
// document's own prefix.
import { init } from "@instantdb/admin";
import * as C from "./constants.ts";
import { loadReadWriteR2Config, type R2ConfigResolved } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import type { ScanCreds } from "./scanCreds.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import type { OrphanSweepTarget } from "./orphanSweep.ts";
import { unwrapToken } from "./randomToken.ts";
import { type DeleteResult, type ObjectInfo, R2Client } from "./r2.ts";
import { formatBytes, type RunStats } from "./stats.ts";

export interface CleanBucketOptions {
  dryRun: boolean;
  // Returns true to proceed with deletion; called only in live mode with
  // at least one orphan, after listing/orphan computation (so the prompt
  // can state the real count/bytes).
  confirm: (message: string) => Promise<boolean>;
}

export interface CleanBucketResult {
  stats: RunStats;
  orphans: ObjectInfo[];
}

interface AdminIdentity {
  authId: string;
  umk: Buffer;
  r2: R2Client;
}

function computeOrphans(
  objects: ObjectInfo[],
  known: Set<string>,
): ObjectInfo[] {
  return objects.filter((o) => !known.has(o.key));
}

function totalBytes(objects: ObjectInfo[]): number {
  return objects.reduce((sum, o) => sum + o.size, 0);
}

function knownPathSet(targets: OrphanSweepTarget[]): Set<string> {
  const known = new Set<string>();
  for (const target of targets) {
    for (const rawKey of target.knownRawKeys) {
      known.add(`${target.prefix}/${rawKey}`);
    }
  }
  return known;
}

export class TxtBucketCleaner {
  private creds: ScanCreds;
  private log: Logger;

  constructor(creds: ScanCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async clean(opts: CleanBucketOptions): Promise<CleanBucketResult> {
    const startedAt = Date.now();
    const crypto = await CryptoEngine.create();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    const admin = await this.resolveAdmin(db, crypto);
    const targets = await this.resolveOwnedDocuments(db, crypto, admin);
    const known = knownPathSet(targets);
    this.log.info(
      `Found ${known.size} known object path(s) in InstantDB across ${targets.length} document(s)`,
    );
    const objects = await admin.r2.listAllObjects();
    const orphans = computeOrphans(objects, known);
    this.log.info(
      `Found ${orphans.length} orphaned object(s) not present in InstantDB (${formatBytes(totalBytes(orphans))})`,
    );
    const deleteResult = await this.maybeDelete(admin.r2, orphans, opts);
    const stats = this.buildStats(
      opts.dryRun,
      targets.length,
      known.size,
      objects,
      orphans,
      deleteResult,
      startedAt,
    );
    return { stats, orphans };
  }

  // Finds the one $users row (type: "admin") whose umk actually decrypts
  // under this creds.json's own user_root_key -- there's no other way to
  // know which admin row it belongs to without trying each candidate (AEAD
  // tag verification fails hard on a wrong key, so this is safe: exactly
  // one candidate can ever succeed). Then unwraps that account's own
  // admin credential row for the read-write r2_config used by every R2
  // operation below, since only the admin ever owns content.
  private async resolveAdmin(
    db: any,
    crypto: CryptoEngine,
  ): Promise<AdminIdentity> {
    const result = await db.query({
      $users: { $: { where: { type: "admin" } } },
    });
    const candidates = result.$users ?? [];
    for (const row of candidates) {
      let umk: Buffer;
      try {
        umk = crypto.blobDecrypt(
          this.creds.userRootKey,
          Buffer.from(row.umk, "base64"),
          false,
        );
      } catch {
        // Wrong admin candidate for this user_root_key -- try the next one.
        continue;
      }
      const r2Config = await this.resolveOwnCredStore(db, crypto, row.id, umk);
      this.log.info(`Resolved admin identity: auth.id=${row.id}`);
      return {
        authId: row.id,
        umk,
        r2: new R2Client(r2Config, false, this.log),
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
  private async resolveOwnCredStore(
    db: any,
    crypto: CryptoEngine,
    ownerId: string,
    umk: Buffer,
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
        this.log.debug(
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
  // parts' raw_key already decrypted -- paginated (order by seq -- an
  // entity's own built-in `id` is NOT usable in an InstaQL `order` clause,
  // confirmed against a real InstantDB app: "The `txt.id` attribute is not
  // indexed"/"not typed. Only indexed and typed attributes can be used to
  // order by." seq is indexed and set on every txt row by --ingest) rather
  // than one unpaginated query, since a large corpus risks exceeding
  // InstantDB's own query timeout otherwise.
  private async resolveOwnedDocuments(
    db: any,
    crypto: CryptoEngine,
    admin: AdminIdentity,
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
            order: { seq: "asc" },
            limit: C.INSTAQL_QUERY_PAGE_SIZE,
            offset,
          },
          txtParts: {},
        },
      });
      const page = result.txt ?? [];
      this.log.info(`Fetched ${offset + page.length} txt row(s) so far...`);
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

  private async maybeDelete(
    r2: R2Client,
    orphans: ObjectInfo[],
    opts: CleanBucketOptions,
  ): Promise<DeleteResult> {
    if (opts.dryRun || orphans.length === 0)
      return { deletedKeys: new Set(), errors: [] };
    await this.confirmOrAbort(orphans, opts.confirm);
    const result = await r2.deleteObjects(orphans.map((o) => o.key));
    this.log.info(
      `Deleted ${result.deletedKeys.size} orphaned object(s) from the R2 bucket`,
    );
    return result;
  }

  private async confirmOrAbort(
    orphans: ObjectInfo[],
    confirm: CleanBucketOptions["confirm"],
  ): Promise<void> {
    const message = `Delete ${orphans.length} orphaned object(s) (${formatBytes(totalBytes(orphans))}) from the R2 bucket? This cannot be undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  private buildStats(
    dryRun: boolean,
    txtCount: number,
    totalKnownPaths: number,
    objects: ObjectInfo[],
    orphans: ObjectInfo[],
    deleteResult: DeleteResult,
    startedAt: number,
  ): RunStats {
    const deleted = orphans.filter((o) => deleteResult.deletedKeys.has(o.key));
    return {
      dryRun,
      txtCount,
      totalKnownPaths,
      totalObjects: objects.length,
      orphanCount: orphans.length,
      orphanBytes: totalBytes(orphans),
      deletedCount: deleteResult.deletedKeys.size,
      deletedBytes: totalBytes(deleted),
      deleteErrors: deleteResult.errors,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

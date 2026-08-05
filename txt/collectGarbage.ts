// Orchestrates --collect-garbage: sweeps every document (`txt` row) this
// admin owns for orphaned R2 objects (docs/protocols.md's Garbage
// collection, Orphan sweep). There is no per-account page-version sweep to
// run in this design -- a `txtParts` row is written exactly once and never
// revised in place (docs/protocols.md's Ingest / write path), so there's no
// superseded-version cleanup for anything to leave behind -- and no
// cross-account escrow lookup either, since only the admin ever owns
// content (docs/data_model.md's Operating model): this tool only ever needs
// the admin's own identity, never another account's.
import { init } from "@instantdb/admin";
import * as C from "./constants.ts";
import { loadReadWriteR2Config, type R2ConfigResolved } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import type { GcCreds } from "./gcCreds.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import { type OrphanSweepTarget, sweepOrphanObjects } from "./orphanSweep.ts";
import { unwrapToken } from "./randomToken.ts";
import { R2Client } from "./r2.ts";

export interface CollectGarbageOptions {
  dryRun: boolean;
  // Returns true to proceed. Called once, before touching any R2 object --
  // only in live mode (dry-run never deletes, so never needs to ask).
  confirm: (message: string) => Promise<boolean>;
}

export interface CollectGarbageResult {
  dryRun: boolean;
  documentCount: number;
  staleObjectsDeleted: number;
}

interface AdminIdentity {
  authId: string;
  umk: Buffer;
  r2: R2Client;
}

export class GarbageCollector {
  private creds: GcCreds;
  private log: Logger;

  constructor(creds: GcCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async run(opts: CollectGarbageOptions): Promise<CollectGarbageResult> {
    const crypto = await CryptoEngine.create();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    const admin = await this.resolveAdmin(db, crypto);
    const targets = await this.resolveSweepTargets(db, crypto, admin);
    this.log.info(
      `Found ${targets.length} document(s) to sweep for orphaned R2 objects`,
    );
    if (targets.length > 0 && !opts.dryRun) {
      await this.confirmOrAbort(targets.length, opts.confirm);
    }
    const staleObjectsDeleted = await sweepOrphanObjects(
      admin.r2,
      targets,
      this.log,
      opts.dryRun,
    );
    return {
      dryRun: opts.dryRun,
      documentCount: targets.length,
      staleObjectsDeleted,
    };
  }

  // Finds the one $users row (appRole: "admin") whose umk actually decrypts
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
      $users: { $: { where: { appRole: "admin" } } },
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
  // parts' raw_key already decrypted -- paginated (order by sourceTxtId --
  // an entity's own built-in `id` is NOT usable in an InstaQL `order`
  // clause, confirmed against a real InstantDB app: "The `txt.id` attribute
  // is not indexed"/"not typed. Only indexed and typed attributes can be
  // used to order by." sourceTxtId is indexed and, today, set on every txt
  // row -- only --migrate ever creates one) rather than one unpaginated
  // query, since a large corpus risks exceeding InstantDB's own query
  // timeout otherwise.
  private async resolveSweepTargets(
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
            order: { sourceTxtId: "asc" },
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

  private async confirmOrAbort(
    documentCount: number,
    confirm: CollectGarbageOptions["confirm"],
  ): Promise<void> {
    const message =
      `Garbage-collect ${documentCount} document(s): delete every untracked R2 object under ` +
      `each document's own prefix? This cannot be undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }
}

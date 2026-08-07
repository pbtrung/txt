// Backfills or repairs txt.prefixHash for every document owned by the admin
// identified by creds.json's user_root_key. The field is derived only after
// decrypting txtKey and txt.prefix locally; the encrypted prefix itself is
// never replaced.
import { init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { CryptoEngine } from "./crypto.ts";
import type { ScanCreds } from "./scanCreds.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import { computePrefixHash } from "./prefixHash.ts";
import { unwrapToken } from "./randomToken.ts";

const PREFIX_HASH_UPDATE_COMMIT_SIZE = 100;

interface AdminIdentity {
  authId: string;
  umk: Buffer;
}

interface TxtRow {
  id: string;
  sourceTxtId?: number;
  txtKey?: string | null;
  prefix?: string | null;
  prefixHash?: string | null;
}

export interface UpdateDbPrefixHashOptions {
  dryRun: boolean;
}

export interface UpdateDbPrefixHashResult {
  dryRun: boolean;
  documentCount: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export class DbPrefixHashUpdater {
  private creds: ScanCreds;
  private log: Logger;

  constructor(creds: ScanCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async run(
    opts: UpdateDbPrefixHashOptions,
  ): Promise<UpdateDbPrefixHashResult> {
    const crypto = await CryptoEngine.create();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    this.log.info(
      "Backfilling txt.prefixHash as Base64(SHA-256(UTF-8(decrypted prefix))); incorrect existing values will be repaired.",
    );
    const admin = await this.resolveAdmin(db, crypto);
    const rows = await this.fetchTxtRows(db, admin.authId);

    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;
    const pending: any[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const count = pending.length;
      if (!opts.dryRun) await db.transact(pending.splice(0));
      else pending.length = 0;
      updated += count;
      this.log.info(
        `${opts.dryRun ? "Prepared" : "Updated"} ${updated} txt.prefixHash row(s) so far...`,
      );
    };

    for (const row of rows) {
      const label = this.rowLabel(row);
      try {
        if (!row.txtKey || !row.prefix) {
          skipped++;
          this.log.warn(`${label}: missing txtKey or prefix, skipped`);
          continue;
        }
        const txtKey = crypto.blobDecrypt(
          admin.umk,
          Buffer.from(row.txtKey, "base64"),
          false,
        );
        const prefix = unwrapToken(crypto, txtKey, row.prefix);
        const prefixHash = computePrefixHash(prefix);
        if (row.prefixHash === prefixHash) {
          unchanged++;
          this.log.debug(`${label}: prefixHash already current`);
          continue;
        }

        pending.push(tx.txt![row.id]!.update({ prefixHash }));
        this.log.debug(
          `${label}: queued ${row.prefixHash ? "repair" : "backfill"} of prefixHash`,
        );
        if (pending.length >= PREFIX_HASH_UPDATE_COMMIT_SIZE) await flush();
      } catch (error) {
        failed++;
        this.log.warn(
          `${label}: failed to derive prefixHash: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await flush();

    return {
      dryRun: opts.dryRun,
      documentCount: rows.length,
      updated,
      unchanged,
      skipped,
      failed,
    };
  }

  // Finds the admin whose umk decrypts under this creds.json's
  // user_root_key, without needing a Firebase sign-in.
  private async resolveAdmin(
    db: any,
    crypto: CryptoEngine,
  ): Promise<AdminIdentity> {
    const result = await db.query({
      $users: { $: { where: { type: "admin" } } },
    });
    const candidates = result.$users ?? [];
    for (const row of candidates) {
      try {
        const umk = crypto.blobDecrypt(
          this.creds.userRootKey,
          Buffer.from(row.umk, "base64"),
          false,
        );
        this.log.info(`Resolved admin identity: auth.id=${row.id}`);
        return { authId: row.id, umk };
      } catch {
        // Wrong admin candidate for this user_root_key -- try the next one.
      }
    }
    throw new Error(
      `no admin $users row's umk decrypts under this creds.json's user_root_key ` +
        `(tried ${candidates.length} candidate(s))`,
    );
  }

  private async fetchTxtRows(db: any, authId: string): Promise<TxtRow[]> {
    const rows = await collectAllPages<TxtRow>(async (after) => {
      const offset = (after as number | undefined) ?? 0;
      const result = await db.query({
        txt: {
          $: {
            where: { "owner.id": authId },
            order: { sourceTxtId: "asc" },
            limit: C.INSTAQL_QUERY_PAGE_SIZE,
            offset,
          },
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
    this.log.info(`Found ${rows.length} txt row(s) owned by auth.id=${authId}`);
    return rows;
  }

  private rowLabel(row: TxtRow): string {
    const source =
      typeof row.sourceTxtId === "number"
        ? ` sourceTxtId=${row.sourceTxtId}`
        : "";
    return `txt=${row.id}${source}`;
  }
}

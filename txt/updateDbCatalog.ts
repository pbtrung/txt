import { init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { CryptoEngine } from "./crypto.ts";
import type { GcCreds } from "./gcCreds.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import {
  catalogFromMetadataContent,
  wrapCatalogBlob,
} from "./metadataCatalog.ts";

const CATALOG_UPDATE_COMMIT_SIZE = 100;

interface AdminIdentity {
  authId: string;
  umk: Buffer;
}

interface TxtMetadataRow {
  id?: string;
  content?: string | null;
  catalog?: string | null;
}

interface TxtRow {
  id: string;
  sourceTxtId?: number;
  txtKey?: string | null;
  txtMetadata?: TxtMetadataRow[];
}

export interface UpdateDbCatalogOptions {
  dryRun: boolean;
}

export interface UpdateDbCatalogResult {
  dryRun: boolean;
  documentCount: number;
  metadataRows: number;
  updated: number;
  skipped: number;
  failed: number;
}

export class DbCatalogUpdater {
  private creds: GcCreds;
  private log: Logger;

  constructor(creds: GcCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async run(opts: UpdateDbCatalogOptions): Promise<UpdateDbCatalogResult> {
    const crypto = await CryptoEngine.create();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    this.log.info(
      "Rewriting txtMetadata.catalog for every owned metadata row; existing catalog blobs will be overwritten.",
    );
    const admin = await this.resolveAdmin(db, crypto);
    const rows = await this.fetchTxtRows(db, admin.authId);

    let metadataRows = 0;
    let updated = 0;
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
        `${opts.dryRun ? "Prepared" : "Updated"} ${updated} txtMetadata.catalog row(s) so far...`,
      );
    };

    for (const row of rows) {
      const label = this.rowLabel(row);
      try {
        if (!row.txtKey) {
          skipped++;
          this.log.warn(`${label}: missing txtKey, skipped`);
          continue;
        }
        const metadata = row.txtMetadata?.[0];
        if (!metadata?.id || !metadata.content) {
          skipped++;
          this.log.warn(`${label}: missing txtMetadata.content, skipped`);
          continue;
        }
        if ((row.txtMetadata?.length ?? 0) > 1) {
          this.log.warn(
            `${label}: has ${row.txtMetadata!.length} txtMetadata rows; updating the first one only`,
          );
        }

        const txtKey = crypto.blobDecrypt(
          admin.umk,
          Buffer.from(row.txtKey, "base64"),
          false,
        );
        const content = JSON.parse(
          crypto
            .blobDecrypt(txtKey, Buffer.from(metadata.content, "base64"), true)
            .toString("utf8"),
        );
        const catalog = catalogFromMetadataContent(content);
        const catalogBlob = wrapCatalogBlob(crypto, txtKey, catalog);
        // Always rewrite rather than filling only missing values: catalog is
        // a derived projection, so schema changes such as adding title must
        // backfill rows that already had an older catalog blob.
        pending.push(
          tx.txtMetadata![metadata.id]!.update({ catalog: catalogBlob }),
        );
        metadataRows++;
        this.log.debug(
          `${label}: queued catalog update for ${JSON.stringify(catalog.name)} ` +
            `(${catalog.authors.length} author(s), ${catalog.subjects.length} subject(s), ` +
            `${catalog.publishers.length} publisher(s); ` +
            `${metadata.catalog ? "overwriting existing catalog" : "creating missing catalog"})`,
        );
        if (pending.length >= CATALOG_UPDATE_COMMIT_SIZE) await flush();
      } catch (e) {
        failed++;
        this.log.warn(
          `${label}: failed to derive catalog: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    await flush();

    return {
      dryRun: opts.dryRun,
      documentCount: rows.length,
      metadataRows,
      updated,
      skipped,
      failed,
    };
  }

  // Finds the admin account whose umk decrypts under this creds.json's
  // user_root_key. That keeps this maintenance command independent of
  // Firebase login while still scoping updates to the intended admin-owned
  // corpus.
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
          txtMetadata: { $: { fields: ["content", "catalog"] } },
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

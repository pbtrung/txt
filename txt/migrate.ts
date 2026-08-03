// Orchestrates --migrate: imports every document from a legacy Turso/rqlite
// account (docs/data_model.md as of commit
// 1ed39d433365c39a6973303c171c7bb5510d7e3e -- the schema txt/owner.ts reads)
// across into an already-`--init-admin`-provisioned InstantDB account's own
// per-user SQLCipher database, going through the exact same page-by-page R2
// transport (R2Vfs/RemotePageStore) --init-admin itself uses -- there's no
// separate "migration" write path, just more rows in the same database.
//
// Resumable: each migrated document keeps its *source* txt_id as its target
// txt_id (insertOneDoc), rather than letting the target db assign a fresh
// one -- a re-run only ever needs "SELECT id FROM txt" against the target to
// know which source txt_ids are already there, no separate tracking table.
// Before doing any new work, also sweeps the account's own R2 prefix for
// objects left behind by a previous run that crashed between
// RemotePageStore.commitPages' own R2-upload step and its final InstantDB
// transact (docs/data_model.md's "Untracked R2 objects" GC sweep, scoped to
// this one account rather than a whole-bucket sweep).
import type { DatabaseSync } from "node:sqlite";
import { brotliCompressSync } from "node:zlib";
import { init } from "@instantdb/admin";
import * as C from "./constants.ts";
import { type Creds, loadR2Config, type R2ConfigResolved } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { InitAdminCreds } from "./initAdminCreds.ts";
import { signInToInstant } from "./instantSignIn.ts";
import type { Logger } from "./logger.ts";
import { TxtOwner, type TxtMetadataEntry } from "./owner.ts";
import { computeR2Prefix, decodePagePointerContent } from "./pagePointer.ts";
import { R2Client } from "./r2.ts";
import { R2Vfs } from "./r2Vfs.ts";
import { RemotePageStore } from "./remotePageStore.ts";
import { SqlCipherBuilder } from "./sqlcipherBuilder.ts";

const DB_FILE_NAME = "/migrate-target.db";

export interface MigrateOptions {
  dryRun: boolean;
  // Returns true to proceed with the write. Called only in live mode, once
  // the real document list/sizes are known.
  confirm: (message: string) => Promise<boolean>;
}

export interface MigratedDoc {
  oldTxtId: number;
  name: string;
  partCount: number;
}

export interface MigrateResult {
  committed: boolean;
  authId: string | null;
  migrated: MigratedDoc[];
  alreadyMigratedCount: number;
  staleObjectsDeleted: number;
  newVersion: number | null;
  pageCount: number | null;
}

interface PreparedDoc {
  oldTxtId: number;
  name: string;
  metadataBrotli: Buffer | null;
  parts: Buffer[]; // brotli(raw text) each, part_num order, unchanged from the source
}

interface TargetAccount {
  dbMetaId: string;
  currentVersion: number;
  pageCount: number;
  pageSize: number;
  umkBlob: string;
  contentBlob: string;
}

export class Migrator {
  private fromDb: DatabaseSync;
  private fromCreds: Creds;
  private toCreds: InitAdminCreds;
  private log: Logger;

  constructor(
    fromDb: DatabaseSync,
    fromCreds: Creds,
    toCreds: InitAdminCreds,
    log: Logger,
  ) {
    this.fromDb = fromDb;
    this.fromCreds = fromCreds;
    this.toCreds = toCreds;
    this.log = log;
  }

  async run(opts: MigrateOptions): Promise<MigrateResult> {
    const crypto = await CryptoEngine.create();
    const authId = await signInToInstant(this.toCreds, this.log);
    const db = init({
      appId: this.toCreds.instantAppId,
      adminToken: this.toCreds.instantAdminToken,
    });
    const target = await this.resolveTarget(db, authId);
    const keys = this.unwrapTargetKeys(crypto, target);
    const r2 = new R2Client(keys.r2Config, false, this.log);

    const staleObjectsDeleted = await this.sweepStaleR2Objects(
      db,
      r2,
      crypto,
      keys.pathKey,
      authId,
    );

    const builder = await SqlCipherBuilder.create();
    const store = this.buildStore(db, r2, crypto, authId, keys.pathKey);
    const vfs = await R2Vfs.registerExisting(
      builder.module,
      DB_FILE_NAME,
      target.pageSize,
      target.pageCount,
      target.currentVersion,
      store,
    );
    const dbHandle = builder.open(DB_FILE_NAME, vfs.name, keys.dbKey);
    try {
      const alreadyMigrated = new Set(
        builder.selectInts(dbHandle, "SELECT id FROM txt").map(Number),
      );
      const owner = new TxtOwner(this.fromDb, crypto, this.log);
      const userId = owner.resolveUserId(this.fromCreds);
      const umk = owner.resolveUmk(this.fromCreds, userId);
      const fromR2 = new R2Client(this.fromCreds.r2Config, true, this.log);
      const allTxtIds = owner.listTxtIds(userId);
      const remaining = allTxtIds.filter((id) => !alreadyMigrated.has(id));
      this.log.info(
        `${allTxtIds.length} txt_id(s) total, ${alreadyMigrated.size} already migrated, ` +
          `${remaining.length} remaining: ${remaining.join(", ")}`,
      );
      const metadataDoc = await owner.resolveTxtMetadataDocument(
        userId,
        umk,
        fromR2,
      );
      // Cheap (local counts only, no R2 download) -- dry-run/confirm can
      // report exactly what a live run would migrate without having to
      // download any document's actual content first.
      const summaries = this.summarizeRemaining(owner, metadataDoc, remaining);
      if (remaining.length === 0 || opts.dryRun) {
        return emptyResult(
          summaries,
          alreadyMigrated.size,
          staleObjectsDeleted,
        );
      }
      await this.confirmOrAbort(summaries, alreadyMigrated.size, opts.confirm);

      const namesByTxtId = new Map(summaries.map((s) => [s.oldTxtId, s.name]));

      // MIGRATE_BATCH_SIZE documents at a time -- fetched/decrypted in
      // parallel within a batch (each document's own parts also fetched in
      // parallel, TxtOwner.fetchTxtParts), then inserted locally, rather
      // than downloading every remaining document's content into memory
      // before inserting any of it. The R2/InstantDB commit itself stays a
      // single step after every batch is inserted, not one per batch:
      // R2Vfs.diffDirtyPages() diffs against a fixed snapshot taken when the
      // VFS was opened, so calling it more than once would just re-report
      // (and re-upload) earlier batches' already-dirty pages every time.
      for (let i = 0; i < remaining.length; i += C.MIGRATE_BATCH_SIZE) {
        const batchIds = remaining.slice(i, i + C.MIGRATE_BATCH_SIZE);
        const batchDocs = await Promise.all(
          batchIds.map((txtId) =>
            this.prepareOneDoc(
              owner,
              umk,
              fromR2,
              metadataDoc,
              txtId,
              namesByTxtId.get(txtId)!,
            ),
          ),
        );
        batchDocs.forEach((doc) => this.insertOneDoc(builder, dbHandle, doc));
        this.log.info(
          `Batch ${Math.floor(i / C.MIGRATE_BATCH_SIZE) + 1}: ` +
            `inserted ${batchDocs.length} document(s) locally (${i + batchDocs.length}/${remaining.length})`,
        );
      }

      const { newVersion } = await this.commit(
        store,
        target,
        vfs.diffDirtyPages(),
        vfs.currentPageCount,
      );
      return {
        committed: true,
        authId,
        migrated: summaries,
        alreadyMigratedCount: alreadyMigrated.size,
        staleObjectsDeleted,
        newVersion,
        pageCount: vfs.currentPageCount,
      };
    } finally {
      builder.close(dbHandle);
    }
  }

  // No R2/decrypt work at all -- just this doc's name (from the already-
  // resolved metadata document) and a cheap local COUNT(*) for part count.
  private summarizeRemaining(
    owner: TxtOwner,
    metadataDoc: Record<string, TxtMetadataEntry> | null,
    remaining: number[],
  ): MigratedDoc[] {
    return remaining.map((txtId) => {
      const entry = metadataDoc?.[String(txtId)];
      return {
        oldTxtId: txtId,
        name: entry?.name ?? this.fallbackName(txtId),
        partCount: owner.countParts(txtId),
      };
    });
  }

  // name comes from summarizeRemaining (already resolved once, up front) --
  // avoids re-deriving it here and double-logging fallbackName's warning.
  private async prepareOneDoc(
    owner: TxtOwner,
    umk: Buffer,
    fromR2: R2Client,
    metadataDoc: Record<string, TxtMetadataEntry> | null,
    txtId: number,
    name: string,
  ): Promise<PreparedDoc> {
    const txtKey = owner.resolveTxtKey(txtId, umk);
    const parts = await owner.fetchTxtParts(txtId, txtKey, fromR2);
    const entry = metadataDoc?.[String(txtId)];
    const metadataBrotli = entry?.metadata
      ? brotliCompressSync(Buffer.from(JSON.stringify(entry.metadata), "utf8"))
      : null;
    this.log.debug(
      `txt_id=${txtId}: name=${JSON.stringify(name)}, ${parts.length} part(s)`,
    );
    return { oldTxtId: txtId, name, metadataBrotli, parts };
  }

  private fallbackName(txtId: number): string {
    this.log.warn(
      `txt_id=${txtId}: no name in txt_metadata, using a placeholder`,
    );
    return `migrated-${txtId}`;
  }

  private async confirmOrAbort(
    docs: MigratedDoc[],
    alreadyMigratedCount: number,
    confirm: MigrateOptions["confirm"],
  ): Promise<void> {
    const totalParts = docs.reduce((sum, d) => sum + d.partCount, 0);
    const skipNote =
      alreadyMigratedCount > 0
        ? ` (${alreadyMigratedCount} already migrated, skipped)`
        : "";
    const message =
      `Migrate ${docs.length} document(s) (${totalParts} part(s) total)${skipNote} into the ` +
      `target InstantDB account's SQLCipher database? This appends new pages/rows and cannot be easily undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  // $users/dbMeta/credStore all link directly to $users now (no separate
  // `users` profile entity -- docs/data_model.md) -- so every piece of the
  // target account's own state is a single-hop "owner.id"/"id" lookup by
  // authId, not a two-hop traversal through an intermediate profile row.
  private async resolveTarget(db: any, authId: string): Promise<TargetAccount> {
    const result = await db.query({
      $users: { $: { where: { id: authId } } },
      dbMeta: { $: { where: { "owner.id": authId } } },
      credStore: {
        $: { where: { "owner.id": authId, "user.id": authId } },
      },
    });
    const authRow = result.$users?.[0];
    if (!authRow?.umk) {
      throw new Error(
        `$users row for auth.id=${authId} is missing umk -- run --init-admin first to provision this account`,
      );
    }
    const dbMetaRow = result.dbMeta?.[0];
    if (!dbMetaRow) {
      throw new Error(`auth.id=${authId} has no linked dbMeta row`);
    }
    const credStoreRow = result.credStore?.[0];
    if (!credStoreRow) {
      throw new Error(`auth.id=${authId} has no own credStore row`);
    }
    return {
      dbMetaId: dbMetaRow.id,
      currentVersion: dbMetaRow.currentVersion,
      pageCount: dbMetaRow.pageCount,
      pageSize: dbMetaRow.pageSize,
      umkBlob: authRow.umk,
      contentBlob: credStoreRow.content,
    };
  }

  // r2Config comes from the target's own credStore content, not
  // this.toCreds.r2Config -- the live credStore row (written by --init-admin)
  // is this account's actual R2 connection info, and a local to-creds.json
  // could drift from it (rotated keys, a stale file, etc.). to-creds.json's
  // own r2Config is only ever used for --init-admin's initial bootstrap,
  // before any credStore row exists to read it from.
  private unwrapTargetKeys(
    crypto: CryptoEngine,
    target: TargetAccount,
  ): { pathKey: Buffer; dbKey: Buffer; r2Config: R2ConfigResolved } {
    const umk = crypto.blobDecrypt(
      this.toCreds.userRootKey,
      Buffer.from(target.umkBlob, "base64"),
      false,
    );
    const payload = JSON.parse(
      crypto
        .blobDecrypt(umk, Buffer.from(target.contentBlob, "base64"), true)
        .toString("utf8"),
    );
    return {
      pathKey: Buffer.from(payload.path_key, "base64"),
      dbKey: Buffer.from(payload.db_key, "base64"),
      r2Config: loadR2Config(payload),
    };
  }

  private buildStore(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    authId: string,
    pathKey: Buffer,
  ): RemotePageStore {
    return new RemotePageStore({
      db,
      r2,
      crypto,
      pathKey,
      authId,
    });
  }

  // Reuses the source's own txt_id as the target's txt_id -- what makes a
  // re-run resumable (see this file's header comment) without any separate
  // tracking table: "SELECT id FROM txt" against the target is enough to
  // know which source txt_ids already made it across.
  private insertOneDoc(
    builder: SqlCipherBuilder,
    db: number,
    doc: PreparedDoc,
  ): void {
    builder.insert(
      db,
      "INSERT INTO txt (id, name, metadata, last_part_num, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [doc.oldTxtId, doc.name, doc.metadataBrotli, null, null, Date.now()],
    );
    doc.parts.forEach((content, i) => {
      builder.insert(
        db,
        "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (?, ?, ?)",
        [doc.oldTxtId, i + 1, content],
      );
    });
    this.log.info(
      `txt_id=${doc.oldTxtId}: inserted ${doc.parts.length} part(s), name=${JSON.stringify(doc.name)}`,
    );
  }

  private async commit(
    store: RemotePageStore,
    target: TargetAccount,
    dirtyPages: Map<number, Buffer>,
    pageCount: number,
  ): Promise<{ newVersion: number }> {
    if (dirtyPages.size === 0) {
      this.log.warn("no dirty pages produced -- nothing to commit");
      return { newVersion: target.currentVersion };
    }
    const { newVersion } = await store.commitPages(
      dirtyPages,
      target.dbMetaId,
      target.currentVersion,
      pageCount,
      target.pageSize,
    );
    this.log.info(
      `Committed ${dirtyPages.size} page(s) as version=${newVersion}`,
    );
    return { newVersion };
  }

  // Deletes R2 objects under this account's own r2Prefix that no known
  // `pages` row (any version -- a superseded-but-not-yet-GC'd page's object
  // is still legitimately known, not stale) resolves to. The only way a
  // legitimately-created object ends up here is a previous run that crashed
  // between RemotePageStore.commitPages' own R2 upload step and its final
  // InstantDB transact (docs/data_model.md's commit-protocol failure modes),
  // leaving a real object with no `pages` row ever created for it.
  private async sweepStaleR2Objects(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    pathKey: Buffer,
    authId: string,
  ): Promise<number> {
    const r2Prefix = computeR2Prefix(authId);
    const [objects, known] = await Promise.all([
      r2.listAllObjects(`${r2Prefix}/`),
      this.collectKnownRawPaths(db, crypto, pathKey, r2Prefix, authId),
    ]);
    const stale = objects.filter((o) => !known.has(o.key));
    if (stale.length === 0) {
      this.log.info(`No stale R2 object(s) found under prefix=${r2Prefix}/`);
      return 0;
    }
    this.log.warn(
      `Found ${stale.length} stale R2 object(s) under prefix=${r2Prefix}/ ` +
        `(left by a previous incomplete run) -- deleting`,
    );
    const result = await r2.deleteObjects(stale.map((o) => o.key));
    for (const err of result.errors) {
      this.log.warn(`Failed to delete stale object ${err.key}: ${err.message}`);
    }
    this.log.info(
      `Deleted ${result.deletedKeys.size}/${stale.length} stale object(s)`,
    );
    return result.deletedKeys.size;
  }

  // Every raw_path this account's committed pages resolve to. path lives
  // directly on each pages row now (base64, docs/data_model.md's pages
  // entity) -- no separate pointer row to download per page, just a decrypt
  // once the rows themselves are in hand. Pages through `pages` (tens of
  // thousands of rows for a large, long-lived vault) PAGES_QUERY_PAGE_SIZE
  // at a time via InstantDB's own cursor pagination (order by pageKey --
  // unique+indexed, so a stable sort with no ties -- and
  // `after: pageInfo.pages.endCursor` each round) rather than one
  // unpaginated query, which risks exceeding InstantDB's own query timeout
  // at that scale.
  private async collectKnownRawPaths(
    db: any,
    crypto: CryptoEngine,
    pathKey: Buffer,
    r2Prefix: string,
    authId: string,
  ): Promise<Set<string>> {
    const rows = await collectAllPages<{ path: string }>(async (after) => {
      const result = await db.query({
        pages: {
          $: {
            where: { "owner.id": authId },
            order: { pageKey: "asc" },
            limit: C.PAGES_QUERY_PAGE_SIZE,
            ...(after ? { after } : {}),
          },
        },
      });
      const pageInfo = result.pageInfo?.pages;
      this.log.debug(
        `collectKnownRawPaths: fetched ${result.pages?.length ?? 0} page row(s)` +
          (pageInfo?.hasNextPage ? ", continuing..." : ""),
      );
      return {
        rows: result.pages ?? [],
        hasNextPage: !!pageInfo?.hasNextPage,
        endCursor: pageInfo?.endCursor,
      };
    });
    const known = new Set<string>();
    for (const row of rows) {
      const rawKey = decodePagePointerContent(
        crypto,
        pathKey,
        Buffer.from(row.path, "base64"),
      );
      known.add(`${r2Prefix}/${rawKey}`);
    }
    return known;
  }
}

function emptyResult(
  migrated: MigratedDoc[],
  alreadyMigratedCount: number,
  staleObjectsDeleted: number,
): MigrateResult {
  return {
    committed: false,
    authId: null,
    migrated,
    alreadyMigratedCount,
    staleObjectsDeleted,
    newVersion: null,
    pageCount: null,
  };
}

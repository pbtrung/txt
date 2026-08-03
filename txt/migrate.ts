// Orchestrates --migrate: imports every document from a legacy Turso/rqlite
// account (docs/data_model.md as of commit
// 1ed39d433365c39a6973303c171c7bb5510d7e3e -- the schema txt/owner.ts reads)
// across into an already-`--init-admin`-provisioned InstantDB account's own
// per-user SQLCipher database -- there's no separate "migration" write path,
// just more rows in the same database, committed via the same RemotePageStore
// --init-admin itself uses. The *read* side differs from --init-admin's own
// R2Vfs (which prefetches every one of a fresh database's current pages up
// front -- fine when pageCount starts at 0): reopening an existing, possibly
// large target uses lazyVfs.ts/lazyPageClient.ts's on-demand VFS instead, so
// resuming a long-lived account doesn't mean downloading its entire database
// just to compute a resume plan or insert a few more documents.
//
// Resumable at the *part* level, not just per-document: each migrated
// document keeps its *source* txt_id as its target txt_id, and a re-run
// compares each txt_id's target part count (COUNT(*) against the reopened
// target's own txt_parts) to its source part count to find not just which
// documents are fully done, but how far into a partially-committed one to
// resume from -- no separate tracking table needed either way. This exists
// because commits themselves are chunked at MIGRATE_PARTS_PER_COMMIT parts,
// not one commit per whole document (a document with many parts blew up a
// single commit into "too many pages," confirmed against a real InstantDB
// app) -- so a crash can leave a document with some but not all of its
// parts committed. Before doing any new work, also sweeps the account's own
// R2 prefix for objects left behind by a previous run that crashed between
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
import { startLazyPageWorker } from "./lazyPageClient.ts";
import { registerLazyVfs } from "./lazyVfs.ts";
import type { Logger } from "./logger.ts";
import { TxtOwner, type TxtMetadataEntry } from "./owner.ts";
import { computeR2Prefix, decodePagePointerContent } from "./pagePointer.ts";
import { R2Client } from "./r2.ts";
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
  partCount: number; // parts still remaining to migrate, not the document's total
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

// What's left to do for one document, computed once up front against the
// reopened target's own txt_parts counts -- fromPartNum > 1 means this
// document already has some parts committed from an earlier, interrupted
// run, and only needs the rest.
interface ResumePlan {
  oldTxtId: number;
  name: string;
  metadata: unknown; // this document's txt_metadata entry, if any -- only used when needsTxtRow
  needsTxtRow: boolean;
  fromPartNum: number; // 1-based
  totalParts: number; // this document's total part count in the source
}

interface PreparedDoc {
  oldTxtId: number;
  name: string;
  metadataBrotli: Buffer | null;
  needsTxtRow: boolean;
  fromPartNum: number; // 1-based -- parts[0]'s real part_num
  parts: Buffer[]; // brotli(raw text) each, part_num order, from fromPartNum on
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
    // lazyVfs.ts/lazyPageClient.ts, not R2Vfs: the nested worker_threads
    // Worker this spawns prefetches every one of the target's current pages
    // up front too (lazyPageWorker.ts's own prefetchAllPages), but via a
    // bounded number of batched InstantDB queries (pageNo: {$in: [...]})
    // instead of R2Vfs's one-query-per-page model (bounded concurrency, but
    // still one InstantDB round trip per page) -- far fewer queries against
    // a large, long-lived account's page count, not fewer bytes downloaded.
    // Any page number that didn't exist at construction (i.e. one this run
    // allocates itself) is filled in afterward instead, straight from each
    // commit's own dirty pages (pageWorker.updateCommittedPages below), so
    // it's never re-fetched from InstantDB/R2 at all. The nested Worker
    // needs its own cleanup -- see the finally block.
    const pageWorker = await startLazyPageWorker(
      {
        instantAppId: this.toCreds.instantAppId,
        instantAdminToken: this.toCreds.instantAdminToken,
        r2Config: keys.r2Config,
        pathKey: keys.pathKey,
        authId,
        snapshot: target.currentVersion,
        pageCount: target.pageCount,
        pageSize: target.pageSize,
        verbose: this.log.verbose,
      },
      this.log,
    );
    const vfs = registerLazyVfs(builder.module, {
      pageSize: target.pageSize,
      pageCount: target.pageCount,
      dbFileName: DB_FILE_NAME,
      fetchPage: pageWorker.fetchPage,
    });
    const dbHandle = builder.open(DB_FILE_NAME, vfs.name, keys.dbKey);
    try {
      const owner = new TxtOwner(this.fromDb, crypto, this.log);
      const userId = owner.resolveUserId(this.fromCreds);
      const umk = owner.resolveUmk(this.fromCreds, userId);
      const fromR2 = new R2Client(this.fromCreds.r2Config, true, this.log);
      const allTxtIds = owner.listTxtIds(userId);
      const metadataDoc = await owner.resolveTxtMetadataDocument(
        userId,
        umk,
        fromR2,
      );
      // Cheap (local counts only, no R2 download) -- dry-run/confirm can
      // report exactly what a live run would migrate without having to
      // download any document's actual content first. Also where resume
      // happens: a document already fully committed (target part count >=
      // source total) is skipped entirely; one partially committed only
      // gets its remaining parts planned.
      const plans = this.computeResumePlans(
        builder,
        dbHandle,
        owner,
        metadataDoc,
        allTxtIds,
      );
      const alreadyMigratedCount = allTxtIds.length - plans.length;
      this.log.info(
        `${allTxtIds.length} txt_id(s) total, ${alreadyMigratedCount} already migrated, ` +
          `${plans.length} remaining: ${plans.map((p) => p.oldTxtId).join(", ")}`,
      );
      const summaries = plans.map((p) => ({
        oldTxtId: p.oldTxtId,
        name: p.name,
        partCount: p.totalParts - p.fromPartNum + 1,
      }));
      if (plans.length === 0 || opts.dryRun) {
        return emptyResult(
          summaries,
          alreadyMigratedCount,
          staleObjectsDeleted,
        );
      }
      // console.log calls made from inside the pageWorker's worker_threads
      // Worker aren't written to the terminal directly -- they relay back to
      // this thread over an internal message channel first, with real
      // latency. computeResumePlans above has already fully finished (and
      // every one of its own page fetches has genuinely completed) by this
      // point, but some of that relay's queued output can still land on the
      // terminal after the confirm prompt below has already printed,
      // visually breaking up the prompt and confusing readline's own cursor
      // tracking enough to look like it swallowed the answer. A short pause
      // here lets that queue drain before the prompt appears.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.confirmOrAbort(summaries, alreadyMigratedCount, opts.confirm);

      // MIGRATE_BATCH_SIZE documents fetched/decrypted at a time -- each
      // document's own remaining parts also fetched in parallel (TxtOwner.
      // fetchTxtParts) -- but committed to R2/InstantDB
      // MIGRATE_PARTS_PER_COMMIT parts at a time, immediately after their
      // own local insert: a crash mid-run then only ever loses the one
      // in-flight chunk, not a whole document (let alone a whole batch or
      // run), and no batch has to wait for its slowest document's commits
      // before starting the next batch's downloads. Commits must stay
      // strictly sequential (never run two in parallel): each one CAS-bumps
      // dbMeta.currentVersion off the previous commit's returned version,
      // and RemotePageStore's admin-SDK transacts bypass instant.perms.ts
      // entirely (no real CAS enforcement to fall back on if two raced).
      let currentVersion = target.currentVersion;
      let pageCount = target.pageCount;
      let totalPartsCommitted = 0;
      let totalPagesCommitted = 0;
      for (let i = 0; i < plans.length; i += C.MIGRATE_BATCH_SIZE) {
        const batchPlans = plans.slice(i, i + C.MIGRATE_BATCH_SIZE);
        const batchDocs = await Promise.all(
          batchPlans.map((plan) =>
            this.prepareOneDoc(owner, umk, fromR2, plan),
          ),
        );
        for (const doc of batchDocs) {
          const chunkCount = Math.max(
            1,
            Math.ceil(doc.parts.length / C.MIGRATE_PARTS_PER_COMMIT),
          );
          for (let c = 0; c < chunkCount; c++) {
            const start = c * C.MIGRATE_PARTS_PER_COMMIT;
            const chunk = doc.parts.slice(
              start,
              start + C.MIGRATE_PARTS_PER_COMMIT,
            );
            if (c === 0 && doc.needsTxtRow) {
              this.insertTxtRow(builder, dbHandle, doc);
            }
            if (chunk.length > 0) {
              this.insertPartsChunk(
                builder,
                dbHandle,
                doc.oldTxtId,
                chunk,
                doc.fromPartNum + start,
              );
            }
            const dirtyPages = vfs.diffDirtyPages();
            const committed = await this.commit(
              store,
              target.dbMetaId,
              currentVersion,
              target.pageSize,
              dirtyPages,
              vfs.currentPageCount,
            );
            vfs.markCommitted(dirtyPages);
            pageWorker.updateCommittedPages(dirtyPages);
            currentVersion = committed.newVersion;
            pageCount = vfs.currentPageCount;
            totalPartsCommitted += chunk.length;
            totalPagesCommitted += dirtyPages.size;
            const avgPagesPerPart =
              totalPartsCommitted > 0
                ? (totalPagesCommitted / totalPartsCommitted).toFixed(1)
                : "0.0";
            this.log.info(
              `txt_id=${doc.oldTxtId}: committed ${chunk.length} part(s), ` +
                `${dirtyPages.size} page(s) new/overwritten, version=${currentVersion} ` +
                `-- running total ${totalPartsCommitted} part(s)/${totalPagesCommitted} page(s), ` +
                `avg ${avgPagesPerPart} page(s)/part`,
            );
          }
        }
      }

      return {
        committed: true,
        authId,
        migrated: summaries,
        alreadyMigratedCount,
        staleObjectsDeleted,
        newVersion: currentVersion,
        pageCount,
      };
    } finally {
      builder.close(dbHandle);
      await pageWorker.terminate();
    }
  }

  // No R2/decrypt work at all -- just this doc's name (from the already-
  // resolved metadata document) and cheap local COUNT(*)s (source total via
  // TxtOwner.countParts, target-so-far via the reopened target db's own
  // txt_parts). A document is skipped entirely once its target row exists
  // and its target part count is already >= its source total; otherwise it
  // gets a plan resuming from (target part count + 1).
  private computeResumePlans(
    builder: SqlCipherBuilder,
    dbHandle: number,
    owner: TxtOwner,
    metadataDoc: Record<string, TxtMetadataEntry> | null,
    allTxtIds: number[],
  ): ResumePlan[] {
    const existingTxtIds = new Set(
      builder.selectInts(dbHandle, "SELECT id FROM txt").map(Number),
    );
    const targetPartCounts = new Map<number, number>();
    for (const txtId of builder
      .selectInts(dbHandle, "SELECT txt_id FROM txt_parts")
      .map(Number)) {
      targetPartCounts.set(txtId, (targetPartCounts.get(txtId) ?? 0) + 1);
    }
    const plans: ResumePlan[] = [];
    for (const txtId of allTxtIds) {
      const totalParts = owner.countParts(txtId);
      const already = targetPartCounts.get(txtId) ?? 0;
      if (existingTxtIds.has(txtId) && already >= totalParts) continue;
      const entry = metadataDoc?.[String(txtId)];
      plans.push({
        oldTxtId: txtId,
        name: entry?.name ?? this.fallbackName(txtId),
        metadata: entry?.metadata,
        needsTxtRow: !existingTxtIds.has(txtId),
        fromPartNum: already + 1,
        totalParts,
      });
      if (already > 0) {
        this.log.debug(
          `txt_id=${txtId}: resuming from part ${already + 1} (${already}/${totalParts} already committed)`,
        );
      }
    }
    return plans;
  }

  private async prepareOneDoc(
    owner: TxtOwner,
    umk: Buffer,
    fromR2: R2Client,
    plan: ResumePlan,
  ): Promise<PreparedDoc> {
    // Logged before, not just after, fetchTxtParts: prepareOneDoc runs for a
    // whole MIGRATE_BATCH_SIZE-wide batch concurrently (Promise.all below),
    // and the loop can't move on to inserting/committing any of them until
    // every one resolves -- without this, a document that finishes fast logs
    // its own completion while up to MIGRATE_BATCH_SIZE-1 siblings could
    // still be silently fetching (small ones especially: fetchTxtParts' own
    // progress log only fires past R2_BATCH_CONCURRENCY parts), making the
    // whole batch look stalled even though it's making real progress.
    const remaining = plan.totalParts - plan.fromPartNum + 1;
    this.log.debug(
      `txt_id=${plan.oldTxtId}: name=${JSON.stringify(plan.name)}, fetching ${remaining} part(s)`,
    );
    const txtKey = owner.resolveTxtKey(plan.oldTxtId, umk);
    const parts = await owner.fetchTxtParts(
      plan.oldTxtId,
      txtKey,
      fromR2,
      plan.fromPartNum,
    );
    const metadataBrotli =
      plan.needsTxtRow && plan.metadata
        ? brotliCompressSync(Buffer.from(JSON.stringify(plan.metadata), "utf8"))
        : null;
    this.log.debug(
      `txt_id=${plan.oldTxtId}: fetched all ${parts.length} part(s)`,
    );
    return {
      oldTxtId: plan.oldTxtId,
      name: plan.name,
      metadataBrotli,
      needsTxtRow: plan.needsTxtRow,
      fromPartNum: plan.fromPartNum,
      parts,
    };
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
  // tracking table: comparing the target's own txt/txt_parts counts against
  // the source's is enough to know what's already there (computeResumePlans).
  // Split from the parts insert below since a document's parts now commit in
  // MIGRATE_PARTS_PER_COMMIT-sized chunks -- the txt row itself is only ever
  // inserted once, alongside that document's first chunk.
  private insertTxtRow(
    builder: SqlCipherBuilder,
    db: number,
    doc: PreparedDoc,
  ): void {
    builder.insert(
      db,
      "INSERT INTO txt (id, name, metadata, last_part_num, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [doc.oldTxtId, doc.name, doc.metadataBrotli, null, null, Date.now()],
    );
    this.log.debug(
      `txt_id=${doc.oldTxtId}: inserted txt row, name=${JSON.stringify(doc.name)}`,
    );
  }

  private insertPartsChunk(
    builder: SqlCipherBuilder,
    db: number,
    txtId: number,
    chunk: Buffer[],
    startPartNum: number,
  ): void {
    chunk.forEach((content, i) => {
      builder.insert(
        db,
        "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (?, ?, ?)",
        [txtId, startPartNum + i, content],
      );
    });
  }

  private async commit(
    store: RemotePageStore,
    dbMetaId: string,
    currentVersion: number,
    pageSize: number,
    dirtyPages: Map<number, Buffer>,
    pageCount: number,
  ): Promise<{ newVersion: number }> {
    if (dirtyPages.size === 0) {
      this.log.debug("no dirty pages produced -- nothing to commit");
      return { newVersion: currentVersion };
    }
    const { newVersion } = await store.commitPages(
      dirtyPages,
      dbMetaId,
      currentVersion,
      pageCount,
      pageSize,
    );
    this.log.debug(
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
  // at a time via InstaQL's offset-based pagination (order by pageKey --
  // unique+indexed, so a stable sort with no ties, required for offset
  // pagination to be safe at all -- and `offset` incremented by however many
  // rows actually came back) rather than one unpaginated query, which risks
  // exceeding InstantDB's own query timeout at that scale. Not cursor-based
  // (after/pageInfo): confirmed the Admin SDK's query() never returns
  // pageInfo at all (see txt/instaqlPagination.ts's own header comment) --
  // an earlier version of this method assumed it did and silently stopped
  // after the first page every time.
  private async collectKnownRawPaths(
    db: any,
    crypto: CryptoEngine,
    pathKey: Buffer,
    r2Prefix: string,
    authId: string,
  ): Promise<Set<string>> {
    const rows = await collectAllPages<{ path: string }>(async (after) => {
      const offset = (after as number | undefined) ?? 0;
      const result = await db.query({
        pages: {
          $: {
            where: { "owner.id": authId },
            order: { pageKey: "asc" },
            limit: C.PAGES_QUERY_PAGE_SIZE,
            offset,
          },
        },
      });
      const page = result.pages ?? [];
      this.log.debug(
        `collectKnownRawPaths: fetched ${page.length} page row(s) at offset=${offset}` +
          (page.length === C.PAGES_QUERY_PAGE_SIZE ? ", continuing..." : ""),
      );
      return {
        rows: page,
        hasNextPage: page.length === C.PAGES_QUERY_PAGE_SIZE,
        endCursor: offset + page.length,
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

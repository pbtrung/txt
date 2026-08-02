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
import type { Creds } from "./creds.ts";
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
  usersRowId: string;
  dbMetaId: string;
  currentVersion: number;
  pageCount: number;
  pageSize: number;
  umkBlob: string;
  credsBlob: string;
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
    const r2 = new R2Client(this.toCreds.r2Config, false, this.log);

    const staleObjectsDeleted = await this.sweepStaleR2Objects(
      db,
      r2,
      crypto,
      keys.pathKey,
      authId,
      target.usersRowId,
    );

    const builder = await SqlCipherBuilder.create();
    const store = this.buildStore(db, r2, crypto, authId, target, keys.pathKey);
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
      const docs = await this.prepareDocs(crypto, alreadyMigrated);
      const summaries = docs.map(toSummary);
      if (docs.length === 0 || opts.dryRun) {
        return emptyResult(
          summaries,
          alreadyMigrated.size,
          staleObjectsDeleted,
        );
      }
      await this.confirmOrAbort(docs, alreadyMigrated.size, opts.confirm);
      docs.forEach((doc) => this.insertOneDoc(builder, dbHandle, doc));
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

  private async prepareDocs(
    crypto: CryptoEngine,
    alreadyMigrated: Set<number>,
  ): Promise<PreparedDoc[]> {
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
    const prepared: PreparedDoc[] = [];
    for (const txtId of remaining) {
      prepared.push(
        await this.prepareOneDoc(owner, umk, fromR2, metadataDoc, txtId),
      );
    }
    return prepared;
  }

  private async prepareOneDoc(
    owner: TxtOwner,
    umk: Buffer,
    fromR2: R2Client,
    metadataDoc: Record<string, TxtMetadataEntry> | null,
    txtId: number,
  ): Promise<PreparedDoc> {
    const txtKey = owner.resolveTxtKey(txtId, umk);
    const parts = await owner.fetchTxtParts(txtId, txtKey, fromR2);
    const entry = metadataDoc?.[String(txtId)];
    const name = entry?.name ?? this.fallbackName(txtId);
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
    docs: PreparedDoc[],
    alreadyMigratedCount: number,
    confirm: MigrateOptions["confirm"],
  ): Promise<void> {
    const totalParts = docs.reduce((sum, d) => sum + d.parts.length, 0);
    const skipNote =
      alreadyMigratedCount > 0
        ? ` (${alreadyMigratedCount} already migrated, skipped)`
        : "";
    const message =
      `Migrate ${docs.length} document(s) (${totalParts} part(s) total)${skipNote} into the ` +
      `target InstantDB account's SQLCipher database? This appends new pages/rows and cannot be easily undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  private async resolveTarget(db: any, authId: string): Promise<TargetAccount> {
    const result = await db.query({
      users: { $: { where: { "authUser.id": authId } }, dbMeta: {} },
      $users: { $: { where: { id: authId } } },
    });
    const usersRow = result.users?.[0];
    if (!usersRow) {
      throw new Error(
        `no users row for auth.id=${authId} -- run --init-admin first to provision this account`,
      );
    }
    const authRow = result.$users?.[0];
    if (!authRow?.umk || !authRow?.creds) {
      throw new Error(`$users row for auth.id=${authId} is missing umk/creds`);
    }
    // InstaQL returns a linked sub-entity as an array regardless of that
    // link's own cardinality (confirmed already for pages.pointerFile in
    // remotePageStore.ts -- users.dbMeta, also a "has: one" reverse link,
    // behaves the same way: dbMeta itself, not [0], was silently undefined
    // everywhere below, which produced a 0-byte "reopened" database that
    // SQLite just treated as a brand-new empty one -- no error until the
    // first real query against it, "no such table: txt").
    const dbMetaRow = usersRow.dbMeta?.[0];
    if (!dbMetaRow) {
      throw new Error(`users row ${usersRow.id} has no linked dbMeta row`);
    }
    return {
      usersRowId: usersRow.id,
      dbMetaId: dbMetaRow.id,
      currentVersion: dbMetaRow.currentVersion,
      pageCount: dbMetaRow.pageCount,
      pageSize: dbMetaRow.pageSize,
      umkBlob: authRow.umk,
      credsBlob: authRow.creds,
    };
  }

  private unwrapTargetKeys(
    crypto: CryptoEngine,
    target: TargetAccount,
  ): { pathKey: Buffer; dbKey: Buffer } {
    const umk = crypto.blobDecrypt(
      this.toCreds.userRootKey,
      Buffer.from(target.umkBlob, "base64"),
    );
    const payload = JSON.parse(
      crypto
        .blobDecrypt(umk, Buffer.from(target.credsBlob, "base64"))
        .toString("utf8"),
    );
    return {
      pathKey: Buffer.from(payload.path_key, "base64"),
      dbKey: Buffer.from(payload.db_key, "base64"),
    };
  }

  private buildStore(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    authId: string,
    target: TargetAccount,
    pathKey: Buffer,
  ): RemotePageStore {
    return new RemotePageStore({
      db,
      r2,
      crypto,
      pathKey,
      authId,
      ownerId: target.usersRowId,
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
  // leaving a real object with no `pages`/`$files` row ever created for it.
  private async sweepStaleR2Objects(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    pathKey: Buffer,
    authId: string,
    usersRowId: string,
  ): Promise<number> {
    const r2Prefix = computeR2Prefix(authId);
    const [objects, known] = await Promise.all([
      r2.listAllObjects(`${r2Prefix}/`),
      this.collectKnownRawPaths(db, crypto, pathKey, r2Prefix, usersRowId),
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

  // Every raw_path this account's committed pages resolve to. There's no way
  // to recover raw_path from InstantDB metadata alone -- it's only ever
  // visible as $files' encrypted content (docs/data_model.md's $files
  // design) -- so this means downloading and decrypting every pointerFile.
  // Pages through `pages` (tens of thousands of rows for a large, long-lived
  // vault) PAGES_QUERY_PAGE_SIZE at a time via InstantDB's own cursor
  // pagination (order by pageKey -- unique+indexed, so a stable sort with no
  // ties -- and `after: pageInfo.pages.endCursor` each round) rather than one
  // unpaginated query, which risks exceeding InstantDB's own query timeout
  // at that scale.
  private async collectKnownRawPaths(
    db: any,
    crypto: CryptoEngine,
    pathKey: Buffer,
    r2Prefix: string,
    usersRowId: string,
  ): Promise<Set<string>> {
    const rows = await collectAllPages<{ pointerFile?: { url: string }[] }>(
      async (after) => {
        const result = await db.query({
          pages: {
            $: {
              where: { "owner.id": usersRowId },
              order: { pageKey: "asc" },
              limit: C.PAGES_QUERY_PAGE_SIZE,
              ...(after ? { after } : {}),
            },
            pointerFile: {},
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
      },
    );
    const urls = rows.flatMap((r) => r.pointerFile?.[0]?.url ?? []);
    const known = new Set<string>();
    for (let i = 0; i < urls.length; i += C.R2_BATCH_CONCURRENCY) {
      const batch = urls.slice(i, i + C.R2_BATCH_CONCURRENCY);
      const rawKeys = await Promise.all(
        batch.map((url) => this.fetchAndDecodeRawKey(crypto, pathKey, url)),
      );
      rawKeys.forEach((rawKey) => known.add(`${r2Prefix}/${rawKey}`));
    }
    return known;
  }

  private async fetchAndDecodeRawKey(
    crypto: CryptoEngine,
    pathKey: Buffer,
    url: string,
  ): Promise<string> {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `failed to download $files pointer content: HTTP ${resp.status} (${url})`,
      );
    }
    const content = Buffer.from(await resp.arrayBuffer());
    return decodePagePointerContent(crypto, pathKey, content);
  }
}

function toSummary(doc: PreparedDoc): MigratedDoc {
  return {
    oldTxtId: doc.oldTxtId,
    name: doc.name,
    partCount: doc.parts.length,
  };
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

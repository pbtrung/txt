// Orchestrates --migrate: pulls a random sample of a legacy Turso/rqlite
// account's documents (docs/data_model.md as of commit
// 1ed39d433365c39a6973303c171c7bb5510d7e3e -- the schema txt/owner.ts reads)
// across into an already-`--init-admin`-provisioned InstantDB account's own
// per-user SQLCipher database, going through the exact same page-by-page R2
// transport (R2Vfs/RemotePageStore) --init-admin itself uses -- there's no
// separate "migration" write path, just more rows in the same database.
import type { DatabaseSync } from "node:sqlite";
import { brotliCompressSync } from "node:zlib";
import { init } from "@instantdb/admin";
import type { Creds } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import type { InitAdminCreds } from "./initAdminCreds.ts";
import { signInToInstant } from "./instantSignIn.ts";
import type { Logger } from "./logger.ts";
import { TxtOwner, type TxtMetadataEntry } from "./owner.ts";
import { computeR2Prefix } from "./pagePointer.ts";
import { R2Client } from "./r2.ts";
import { R2Vfs } from "./r2Vfs.ts";
import { RemotePageStore } from "./remotePageStore.ts";
import { SqlCipherBuilder } from "./sqlcipherBuilder.ts";

const DB_FILE_NAME = "/migrate-target.db";

export interface MigrateOptions {
  sampleSize: number;
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
  newTxtIds: bigint[];
  migrated: MigratedDoc[];
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

function pickRandom<T>(items: T[], n: number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
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
    const docs = await this.prepareDocs(crypto, opts.sampleSize);
    const summaries = docs.map(toSummary);
    if (docs.length === 0 || opts.dryRun) {
      return emptyResult(summaries);
    }
    await this.confirmOrAbort(docs, opts.confirm);
    return this.writeToTarget(crypto, docs, summaries);
  }

  private async prepareDocs(
    crypto: CryptoEngine,
    sampleSize: number,
  ): Promise<PreparedDoc[]> {
    const owner = new TxtOwner(this.fromDb, crypto, this.log);
    const userId = owner.resolveUserId(this.fromCreds);
    const umk = owner.resolveUmk(this.fromCreds, userId);
    const fromR2 = new R2Client(this.fromCreds.r2Config, true, this.log);
    const allTxtIds = owner.listTxtIds(userId);
    const selected = pickRandom(allTxtIds, sampleSize);
    this.log.info(
      `Selected ${selected.length}/${allTxtIds.length} txt_id(s) to migrate: ${selected.join(", ")}`,
    );
    const metadataDoc = await owner.resolveTxtMetadataDocument(
      userId,
      umk,
      fromR2,
    );
    const prepared: PreparedDoc[] = [];
    for (const txtId of selected) {
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
    confirm: MigrateOptions["confirm"],
  ): Promise<void> {
    const totalParts = docs.reduce((sum, d) => sum + d.parts.length, 0);
    const message =
      `Migrate ${docs.length} document(s) (${totalParts} part(s) total) into the ` +
      `target InstantDB account's SQLCipher database? This appends new pages/rows and cannot be easily undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  private async writeToTarget(
    crypto: CryptoEngine,
    docs: PreparedDoc[],
    summaries: MigratedDoc[],
  ): Promise<MigrateResult> {
    const authId = await signInToInstant(this.toCreds, this.log);
    const db = init({
      appId: this.toCreds.instantAppId,
      adminToken: this.toCreds.instantAdminToken,
    });
    const target = await this.resolveTarget(db, authId);
    const keys = this.unwrapTargetKeys(crypto, target);
    const store = this.buildStore(db, crypto, authId, target, keys.pathKey);
    const builder = await SqlCipherBuilder.create();
    const { newTxtIds, dirtyPages, pageCount } = await this.writeDocs(
      builder,
      store,
      target,
      keys.dbKey,
      docs,
    );
    const { newVersion } = await this.commit(
      store,
      target,
      dirtyPages,
      pageCount,
    );
    return {
      committed: true,
      authId,
      newTxtIds,
      migrated: summaries,
      newVersion,
      pageCount,
    };
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
    return {
      usersRowId: usersRow.id,
      dbMetaId: usersRow.dbMeta.id,
      currentVersion: usersRow.dbMeta.currentVersion,
      pageCount: usersRow.dbMeta.pageCount,
      pageSize: usersRow.dbMeta.pageSize,
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
    crypto: CryptoEngine,
    authId: string,
    target: TargetAccount,
    pathKey: Buffer,
  ): RemotePageStore {
    const r2 = new R2Client(this.toCreds.r2Config, false, this.log);
    return new RemotePageStore({
      db,
      r2,
      crypto,
      pathKey,
      authId,
      r2Prefix: computeR2Prefix(authId),
      ownerId: target.usersRowId,
    });
  }

  private async writeDocs(
    builder: SqlCipherBuilder,
    store: RemotePageStore,
    target: TargetAccount,
    dbKey: Buffer,
    docs: PreparedDoc[],
  ): Promise<{
    newTxtIds: bigint[];
    dirtyPages: Map<number, Buffer>;
    pageCount: number;
  }> {
    const vfs = await R2Vfs.registerExisting(
      builder.module,
      DB_FILE_NAME,
      target.pageSize,
      target.pageCount,
      target.currentVersion,
      store,
    );
    const dbHandle = builder.open(DB_FILE_NAME, vfs.name, dbKey);
    let newTxtIds: bigint[];
    try {
      newTxtIds = docs.map((doc) => this.insertOneDoc(builder, dbHandle, doc));
    } finally {
      builder.close(dbHandle);
    }
    return {
      newTxtIds,
      dirtyPages: vfs.diffDirtyPages(),
      pageCount: vfs.currentPageCount,
    };
  }

  private insertOneDoc(
    builder: SqlCipherBuilder,
    db: number,
    doc: PreparedDoc,
  ): bigint {
    const newTxtId = builder.insert(
      db,
      "INSERT INTO txt (name, metadata, last_part_num, last_accessed, created_at) VALUES (?, ?, ?, ?, ?)",
      [doc.name, doc.metadataBrotli, null, null, Date.now()],
    );
    doc.parts.forEach((content, i) => {
      builder.insert(
        db,
        "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (?, ?, ?)",
        [newTxtId, i + 1, content],
      );
    });
    this.log.info(
      `txt_id(old)=${doc.oldTxtId} -> txt_id(new)=${newTxtId}: inserted ${doc.parts.length} part(s), name=${JSON.stringify(doc.name)}`,
    );
    return newTxtId;
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
}

function toSummary(doc: PreparedDoc): MigratedDoc {
  return {
    oldTxtId: doc.oldTxtId,
    name: doc.name,
    partCount: doc.parts.length,
  };
}

function emptyResult(migrated: MigratedDoc[]): MigrateResult {
  return {
    committed: false,
    authId: null,
    newTxtIds: [],
    migrated,
    newVersion: null,
    pageCount: null,
  };
}

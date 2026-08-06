// Orchestrates --migrate: imports every document from a legacy account
// snapshot (the schema txt/owner.ts reads) into an already-`--init-admin`-
// provisioned InstantDB account, re-encrypting every part under this
// design's current key hierarchy (docs/key_hierarchy.md) as it goes --
// there's no separate "migration" write path beyond that: a migrated
// document's txt/txtMetadata/txtParts rows and R2 objects are
// indistinguishable from ones any other ingest path would produce, aside
// from carrying `txt.sourceTxtId` (docs/data_model.md's txt entity) for
// resumability.
//
// Resumable at the *part* level, not just per-document: each migrated
// document's target `txt` row carries the source snapshot's own `txt_id` as
// `sourceTxtId`, so a re-run can find, for every source document, whether a
// target row already exists for it and (via that row's own linked
// `txtParts`) how many of its parts already landed -- no separate tracking
// table needed either way. This exists because writes themselves are
// chunked at MIGRATE_PARTS_PER_COMMIT parts, not one transact() per whole
// document (a document with many parts risks blowing up a single
// db.transact() into "too many rows," confirmed against a real InstantDB
// app) -- so a crash can leave a document with some but not all of its
// parts committed. Before doing any new work, also sweeps every
// already-migrated document's own R2 prefix for objects left behind by a
// previous run that crashed between a part's own R2 PUT and its txtParts
// transact (docs/protocols.md's Ingest/write path failure mode), scoped per
// document rather than one flat account-wide sweep, since every document
// now has its own random prefix (docs/data_model.md's txt entity).
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { id, init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import {
  type Creds,
  loadReadWriteR2Config,
  type R2ConfigResolved,
} from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { InitAdminCreds } from "./initAdminCreds.ts";
import { signInToInstant } from "./instantSignIn.ts";
import type { Logger } from "./logger.ts";
import {
  catalogFromMetadataContent,
  wrapCatalogBlob,
  type TxtMetadataContent,
} from "./metadataCatalog.ts";
import { type OrphanSweepTarget, sweepOrphanObjects } from "./orphanSweep.ts";
import { TxtOwner, type TxtMetadataEntry } from "./owner.ts";
import { computePrefixHash } from "./prefixHash.ts";
import { generateRandomToken, unwrapToken, wrapToken } from "./randomToken.ts";
import { R2Client } from "./r2.ts";

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
}

interface TargetAdmin {
  authId: string;
  umk: Buffer;
  r2Config: R2ConfigResolved;
}

// One already-migrated document's target-side state, fully resolved (every
// part's own raw_key decrypted) up front -- used both to compute how far a
// resume should pick up from and, before that, to sweep that document's own
// R2 prefix for crash leftovers.
interface ExistingTarget {
  txtId: string; // target `txt` row id
  txtKey: Buffer;
  prefix: string; // decrypted, not the wrapped blob
  parts: { partNum: number; rawKey: string }[];
}

// What's left to do for one document, computed once up front against the
// already-resolved target state -- existing !== null means this document
// already has some parts committed from an earlier, interrupted run, and
// only needs the rest.
interface ResumePlan {
  oldTxtId: number;
  name: string;
  metadata: unknown; // this document's txt_metadata entry, if any -- only used when existing === null
  existing: ExistingTarget | null;
  fromPartNum: number; // 1-based
  totalParts: number; // this document's total part count in the source
}

interface PreparedDoc {
  oldTxtId: number;
  txtId: string; // target row id -- existing, or freshly generated for a new document
  isNew: boolean;
  txtKey: Buffer;
  prefix: string;
  name: string;
  metadata: unknown;
  fromPartNum: number; // 1-based -- parts[0]'s real part_num
  parts: Buffer[]; // brotli(raw text) each, part_num order, from fromPartNum on
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
    const admin = await this.resolveTargetAdmin(db, crypto, authId);
    const r2 = new R2Client(admin.r2Config, false, this.log);

    const existingByOldTxtId = await this.resolveExistingTargets(
      db,
      crypto,
      admin,
    );
    const staleObjectsDeleted = await this.sweepStaleR2Objects(
      r2,
      existingByOldTxtId,
    );

    const owner = new TxtOwner(this.fromDb, crypto, this.log);
    const sourceUserId = owner.resolveUserId(this.fromCreds);
    const sourceUmk = owner.resolveUmk(this.fromCreds, sourceUserId);
    const fromR2 = new R2Client(this.fromCreds.r2Config, true, this.log);
    const allTxtIds = owner.listTxtIds(sourceUserId);
    const metadataDoc = await owner.resolveTxtMetadataDocument(
      sourceUserId,
      sourceUmk,
      fromR2,
    );

    // Cheap (local count only, no R2 download) -- dry-run/confirm can report
    // exactly what a live run would migrate without having to download any
    // document's actual content first. Also where resume happens: a
    // document already fully committed (target part count >= source total)
    // is skipped entirely; one partially committed only gets its remaining
    // parts planned.
    const plans = this.computeResumePlans(
      owner,
      metadataDoc,
      allTxtIds,
      existingByOldTxtId,
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
      return emptyResult(summaries, alreadyMigratedCount, staleObjectsDeleted);
    }
    await this.confirmOrAbort(summaries, alreadyMigratedCount, opts.confirm);

    // MIGRATE_BATCH_SIZE documents fetched/decrypted at a time -- each
    // document's own remaining parts also fetched in parallel (TxtOwner.
    // fetchTxtParts) -- but transacted MIGRATE_PARTS_PER_COMMIT parts at a
    // time, immediately after their own R2 upload: a crash mid-run then
    // only ever loses the one in-flight chunk, not a whole document (let
    // alone a whole batch or run), and no batch has to wait for its
    // slowest document's transacts before starting the next batch's
    // downloads.
    let totalPartsCommitted = 0;
    for (let i = 0; i < plans.length; i += C.MIGRATE_BATCH_SIZE) {
      const batchPlans = plans.slice(i, i + C.MIGRATE_BATCH_SIZE);
      const batchDocs = await Promise.all(
        batchPlans.map((plan) =>
          this.prepareOneDoc(owner, sourceUmk, fromR2, plan),
        ),
      );
      for (const doc of batchDocs) {
        totalPartsCommitted += await this.commitDoc(db, r2, crypto, admin, doc);
      }
    }

    return {
      committed: true,
      authId,
      migrated: summaries,
      alreadyMigratedCount,
      staleObjectsDeleted,
    };
  }

  private async resolveTargetAdmin(
    db: any,
    crypto: CryptoEngine,
    authId: string,
  ): Promise<TargetAdmin> {
    const result = await db.query({
      $users: { $: { where: { id: authId } } },
      credStore: { $: { where: { "owner.id": authId } } },
    });
    const authRow = result.$users?.[0];
    if (!authRow?.umk) {
      throw new Error(
        `$users row for auth.id=${authId} is missing umk -- run --init-admin first to provision this account`,
      );
    }
    const umk = crypto.blobDecrypt(
      this.toCreds.userRootKey,
      Buffer.from(authRow.umk, "base64"),
      false,
    );
    const credStoreRows = result.credStore ?? [];
    for (const credStoreRow of credStoreRows) {
      try {
        const credStoreKey = crypto.blobDecrypt(
          umk,
          Buffer.from(credStoreRow.credStoreKey, "base64"),
          false,
        );
        const payload = JSON.parse(
          crypto
            .blobDecrypt(
              credStoreKey,
              Buffer.from(credStoreRow.content, "base64"),
              true,
            )
            .toString("utf8"),
        );
        return { authId, umk, r2Config: loadReadWriteR2Config(payload) };
      } catch (err) {
        this.log.debug(
          `Skipping admin-owned credStore row without read-write R2 config: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    throw new Error(
      `auth.id=${authId} has no admin-owned credStore row with read-write r2_config`,
    );
  }

  // Every document this admin has already migrated, keyed by its source
  // txt_id, with every one of its own parts' raw_key already decrypted --
  // needed both for the stale-object sweep below and for computing each
  // document's own resume point. Paginated (order by sourceTxtId -- an
  // entity's own built-in `id` is NOT usable in an InstaQL `order` clause,
  // confirmed against a real InstantDB app: "The `txt.id` attribute is not
  // indexed"/"not typed. Only indexed and typed attributes can be used to
  // order by." sourceTxtId is indexed and, today, set on every txt row this
  // method sees -- only --migrate ever creates one) rather than one
  // unpaginated query, same reasoning as collectGarbage.ts's own paged
  // queries: a large corpus risks exceeding InstantDB's own query timeout
  // otherwise.
  private async resolveExistingTargets(
    db: any,
    crypto: CryptoEngine,
    admin: TargetAdmin,
  ): Promise<Map<number, ExistingTarget>> {
    const rows = await collectAllPages<{
      id: string;
      sourceTxtId?: number;
      txtKey: string;
      prefix: string;
      txtParts: { partNum: number; txtPartKey: string; path: string }[];
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
      return {
        rows: page,
        hasNextPage: page.length === C.INSTAQL_QUERY_PAGE_SIZE,
        endCursor: offset + page.length,
      };
    });
    const map = new Map<number, ExistingTarget>();
    for (const row of rows) {
      if (typeof row.sourceTxtId !== "number") continue; // not a migrated document
      const txtKey = crypto.blobDecrypt(
        admin.umk,
        Buffer.from(row.txtKey, "base64"),
        false,
      );
      const prefix = unwrapToken(crypto, txtKey, row.prefix);
      const parts = (row.txtParts ?? [])
        .map((p) => {
          const txtPartKey = crypto.blobDecrypt(
            txtKey,
            Buffer.from(p.txtPartKey, "base64"),
            false,
          );
          return {
            partNum: p.partNum,
            rawKey: unwrapToken(crypto, txtPartKey, p.path),
          };
        })
        .sort((a, b) => a.partNum - b.partNum);
      map.set(row.sourceTxtId, { txtId: row.id, txtKey, prefix, parts });
    }
    return map;
  }

  // For every already-migrated document, sweep its own R2 prefix for
  // objects its own known raw_keys don't account for (orphanSweep.ts --
  // shared with collectGarbage.ts, which does the same thing for every
  // txt row this admin owns, not just ones this particular run touches).
  private async sweepStaleR2Objects(
    r2: R2Client,
    existing: Map<number, ExistingTarget>,
  ): Promise<number> {
    const targets: OrphanSweepTarget[] = [...existing.entries()].map(
      ([oldTxtId, target]) => ({
        label: `txt_id=${oldTxtId}`,
        prefix: target.prefix,
        knownRawKeys: new Set(target.parts.map((p) => p.rawKey)),
      }),
    );
    const totalDeleted = await sweepOrphanObjects(r2, targets, this.log, false);
    if (totalDeleted === 0) {
      this.log.info(
        "No stale R2 object(s) found across any already-migrated document",
      );
    }
    return totalDeleted;
  }

  private computeResumePlans(
    owner: TxtOwner,
    metadataDoc: Record<string, TxtMetadataEntry> | null,
    allTxtIds: number[],
    existing: Map<number, ExistingTarget>,
  ): ResumePlan[] {
    const plans: ResumePlan[] = [];
    for (const txtId of allTxtIds) {
      const totalParts = owner.countParts(txtId);
      const target = existing.get(txtId) ?? null;
      const already = target?.parts.length ?? 0;
      if (target && already >= totalParts) continue;
      const entry = metadataDoc?.[String(txtId)];
      plans.push({
        oldTxtId: txtId,
        name: entry?.name ?? this.fallbackName(txtId),
        metadata: entry?.metadata,
        existing: target,
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
    sourceUmk: Buffer,
    fromR2: R2Client,
    plan: ResumePlan,
  ): Promise<PreparedDoc> {
    const remaining = plan.totalParts - plan.fromPartNum + 1;
    this.log.debug(
      `txt_id=${plan.oldTxtId}: name=${JSON.stringify(plan.name)}, fetching ${remaining} part(s)`,
    );
    const sourceTxtKey = owner.resolveTxtKey(plan.oldTxtId, sourceUmk);
    const parts = await owner.fetchTxtParts(
      plan.oldTxtId,
      sourceTxtKey,
      fromR2,
      plan.fromPartNum,
    );
    this.log.debug(
      `txt_id=${plan.oldTxtId}: fetched all ${parts.length} part(s)`,
    );
    if (plan.existing) {
      return {
        oldTxtId: plan.oldTxtId,
        txtId: plan.existing.txtId,
        isNew: false,
        txtKey: plan.existing.txtKey,
        prefix: plan.existing.prefix,
        name: plan.name,
        metadata: plan.metadata,
        fromPartNum: plan.fromPartNum,
        parts,
      };
    }
    return {
      oldTxtId: plan.oldTxtId,
      txtId: id(),
      isNew: true,
      txtKey: randomBytes(C.RANDOM_KEY_LEN),
      prefix: generateRandomToken(),
      name: plan.name,
      metadata: plan.metadata,
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
      `target InstantDB account? This creates new txt/txtMetadata/txtParts rows and R2 objects and cannot be easily undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  // Uploads one document's remaining parts in MIGRATE_PARTS_PER_COMMIT-sized
  // chunks, transacting each chunk (plus, for the first chunk of a brand-new
  // document, its txt/txtMetadata rows) immediately after that chunk's own
  // R2 PUTs land. Returns the total number of parts committed.
  private async commitDoc(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    admin: TargetAdmin,
    doc: PreparedDoc,
  ): Promise<number> {
    const chunkCount = Math.max(
      1,
      Math.ceil(doc.parts.length / C.MIGRATE_PARTS_PER_COMMIT),
    );
    let committed = 0;
    for (let c = 0; c < chunkCount; c++) {
      const start = c * C.MIGRATE_PARTS_PER_COMMIT;
      const chunk = doc.parts.slice(start, start + C.MIGRATE_PARTS_PER_COMMIT);
      if (chunk.length === 0) continue;
      const startPartNum = doc.fromPartNum + start;
      const uploaded = await this.uploadChunk(
        r2,
        crypto,
        doc.txtKey,
        doc.prefix,
        chunk,
        startPartNum,
      );
      const txs = uploaded.map(({ partNum, path, txtPartKeyBlob }) =>
        tx
          .txtParts![id()]!.update({
            partNum,
            txtPartKey: txtPartKeyBlob,
            path,
            partKey: `${doc.txtId}:${partNum}`,
          })
          .link({ txt: doc.txtId, owner: admin.authId }),
      );
      if (c === 0 && doc.isNew) {
        txs.push(
          tx
            .txt![doc.txtId]!.update({
              txtKey: crypto
                .blobEncrypt(admin.umk, doc.txtKey, false)
                .toString("base64"),
              prefix: wrapToken(crypto, doc.txtKey, doc.prefix),
              prefixHash: computePrefixHash(doc.prefix),
              sourceTxtId: doc.oldTxtId,
            })
            .link({ owner: admin.authId }),
          tx
            .txtMetadata![id()]!.update({
              content: this.wrapMetadataContent(crypto, doc),
              catalog: this.wrapMetadataCatalog(crypto, doc),
            })
            .link({ txt: doc.txtId, owner: admin.authId }),
        );
      }
      await db.transact(txs);
      committed += chunk.length;
      this.log.info(
        `txt_id=${doc.oldTxtId}: committed ${chunk.length} part(s) -- running total ${committed}/${doc.parts.length} for this document`,
      );
    }
    return committed;
  }

  private metadataContent(doc: PreparedDoc): TxtMetadataContent {
    const payload: TxtMetadataContent = { name: doc.name };
    if (doc.metadata !== undefined) payload.metadata = doc.metadata;
    return payload;
  }

  private wrapMetadataContent(crypto: CryptoEngine, doc: PreparedDoc): string {
    const payload = this.metadataContent(doc);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    return crypto.blobEncrypt(doc.txtKey, plaintext, true).toString("base64");
  }

  private wrapMetadataCatalog(crypto: CryptoEngine, doc: PreparedDoc): string {
    return wrapCatalogBlob(
      crypto,
      doc.txtKey,
      catalogFromMetadataContent(this.metadataContent(doc)),
    );
  }

  // Pure prep (fresh txtPartKey/raw_key/ciphertext per part, no I/O) up
  // front, then the real R2 PUTs R2_BATCH_CONCURRENCY at a time -- bounded
  // parallelism instead of one part at a time (slow) or all of a chunk at
  // once (risks exhausting connections/R2 rate limits for a bulk migrate).
  private async uploadChunk(
    r2: R2Client,
    crypto: CryptoEngine,
    txtKey: Buffer,
    prefix: string,
    chunk: Buffer[],
    startPartNum: number,
  ): Promise<{ partNum: number; path: string; txtPartKeyBlob: string }[]> {
    const prepared = chunk.map((body, i) => {
      const partNum = startPartNum + i;
      const txtPartKey = randomBytes(C.RANDOM_KEY_LEN);
      const rawKey = generateRandomToken();
      const rawPath = `${prefix}/${rawKey}`;
      // body is already brotli(raw text) as fetched from the source
      // (owner.fetchTxtParts) -- compressed=false here means "don't
      // brotli-compress again," not "this payload isn't compressed."
      const ciphertext = crypto.blobEncrypt(txtPartKey, body, false);
      const path = wrapToken(crypto, txtPartKey, rawKey);
      const txtPartKeyBlob = crypto
        .blobEncrypt(txtKey, txtPartKey, false)
        .toString("base64");
      return { partNum, rawPath, ciphertext, path, txtPartKeyBlob };
    });
    for (let i = 0; i < prepared.length; i += C.R2_BATCH_CONCURRENCY) {
      const batch = prepared.slice(i, i + C.R2_BATCH_CONCURRENCY);
      await Promise.all(
        batch.map((p) => r2.putObject(p.rawPath, p.ciphertext)),
      );
    }
    return prepared.map(({ partNum, path, txtPartKeyBlob }) => ({
      partNum,
      path,
      txtPartKeyBlob,
    }));
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
  };
}

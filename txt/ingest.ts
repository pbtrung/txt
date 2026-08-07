// Orchestrates --ingest: cleans, splits, uploads, and records every .txt
// file in a source directory as its own txt/txtMetadata/txtParts InstantDB
// entities plus per-part R2 objects (docs/protocols.md's Ingest/write
// path), the same design any other write path in this codebase produces --
// there is no separate "ingest-only" row shape.
//
// Resumable by filename only, not by part: a rerun over the same directory
// skips any filename already recorded in an owned document's
// txtMetadata.catalog.name. A file that fails partway is retried from
// scratch next run -- there is no partial per-file state to resume from.
// This is deliberate: nothing is written to InstantDB for a file until
// every one of its parts has already landed in R2 (uploadParts prepares and
// uploads everything first; ingestOneFile's single db.transact only runs
// once that succeeds), so a failed file leaves no half-committed txt row
// behind for a later run to misidentify as already-ingested. Whatever parts
// a failed file did manage to upload are real but unreferenced R2 objects
// -- left for txt.ts --clean-bucket to sweep, not cleaned up here.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { id, init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { loadReadWriteR2Config } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import {
  catalogFromMetadataContent,
  wrapCatalogBlob,
  type TxtMetadataContent,
} from "./metadataCatalog.ts";
import { findOpfSidecar, parseOpfMetadata } from "./opf.ts";
import { computePrefixHash } from "./prefixHash.ts";
import { generateRandomToken, wrapToken } from "./randomToken.ts";
import { R2Client } from "./r2.ts";
import type { ScanCreds } from "./scanCreds.ts";
import { preprocessText, splitParts } from "./textproc.ts";

export interface IngestOptions {
  srcDir: string;
  dryRun: boolean;
}

export interface IngestedDoc {
  name: string;
  txtId: string;
  partCount: number;
}

export interface IngestFailure {
  name: string;
  error: string;
}

export interface IngestResult {
  dryRun: boolean;
  ingested: IngestedDoc[];
  skipped: string[];
  failed: IngestFailure[];
}

interface AdminIdentity {
  authId: string;
  umk: Buffer;
}

interface TxtMetadataCatalogRow {
  catalog?: string | null;
}

interface OwnedTxtRow {
  id: string;
  seq?: number;
  txtKey?: string | null;
  txtMetadata?: TxtMetadataCatalogRow[];
}

interface UploadedPart {
  partNum: number;
  path: string;
  txtPartKeyBlob: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TxtIngester {
  private creds: ScanCreds;
  private log: Logger;

  constructor(creds: ScanCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async run(opts: IngestOptions): Promise<IngestResult> {
    const crypto = await CryptoEngine.create();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    const admin = await this.resolveAdmin(db, crypto);
    const { nextSeq, existingNames } = await this.resolveExistingState(
      db,
      crypto,
      admin,
    );

    const files = this.listSourceFiles(opts.srcDir);
    const { toIngest, skipped } = this.filterNewFiles(files, existingNames);
    if (skipped.length > 0) {
      this.log.info(
        `Skipping ${skipped.length} already-ingested file(s): ${skipped.join(", ")}`,
      );
    }
    this.log.info(
      `Found ${toIngest.length} file(s) to ingest in ${opts.srcDir}`,
    );

    if (opts.dryRun) {
      const ingested = toIngest.map((filePath) => this.previewFile(filePath));
      return { dryRun: true, ingested, skipped, failed: [] };
    }

    const r2 = await this.resolveR2Client(db, crypto, admin);
    const ingested: IngestedDoc[] = [];
    const failed: IngestFailure[] = [];
    let seq = nextSeq;
    // One file at a time -- its own parts still upload concurrently -- not
    // every file's parts in flight at once.
    for (const filePath of toIngest) {
      const name = basename(filePath);
      try {
        const result = await this.ingestOneFile(
          db,
          r2,
          crypto,
          admin,
          filePath,
          seq,
        );
        if (result) {
          ingested.push(result);
          seq += 1;
        } else {
          failed.push({ name, error: "upload or commit failed -- see log" });
        }
      } catch (err) {
        this.log.warn(`${name}: unexpected error, skipping: ${errMsg(err)}`);
        failed.push({ name, error: errMsg(err) });
      }
    }
    return { dryRun: false, ingested, skipped, failed };
  }

  private previewFile(filePath: string): IngestedDoc {
    const name = basename(filePath);
    const parts = splitParts(readFileSync(filePath));
    this.log.info(`${name}: would ingest ${parts.length} part(s)`);
    return { name, txtId: "(dry-run)", partCount: parts.length };
  }

  // Finds the one admin $users row whose umk actually decrypts under this
  // creds.json's own user_root_key -- same pattern as bucket.ts's
  // resolveAdmin (AEAD tag verification fails hard on a wrong key, so this
  // is safe: exactly one candidate can ever succeed).
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

  // The admin's own credStore row with a read-write r2_config -- same
  // pattern as bucket.ts's resolveOwnCredStore. Only called for a live
  // (non-dry-run) run: a preview never uploads or lists R2 at all.
  private async resolveR2Client(
    db: any,
    crypto: CryptoEngine,
    admin: AdminIdentity,
  ): Promise<R2Client> {
    const result = await db.query({
      credStore: { $: { where: { "owner.id": admin.authId } } },
    });
    const rows = result.credStore ?? [];
    for (const row of rows) {
      try {
        const credStoreKey = crypto.blobDecrypt(
          admin.umk,
          Buffer.from(row.credStoreKey, "base64"),
          false,
        );
        const payload = JSON.parse(
          crypto
            .blobDecrypt(credStoreKey, Buffer.from(row.content, "base64"), true)
            .toString("utf8"),
        );
        return new R2Client(loadReadWriteR2Config(payload), false, this.log);
      } catch (err) {
        this.log.debug(
          `Skipping admin-owned credStore row without read-write R2 config: ${errMsg(err)}`,
        );
      }
    }
    throw new Error(
      `no admin-owned credStore row with read-write r2_config for auth.id=${admin.authId}`,
    );
  }

  // One paginated pass over every owned txt row (order by seq -- an
  // entity's own built-in id can't be used in an InstaQL order clause, see
  // bucket.ts) to compute both things a fresh ingest run needs before
  // touching any file: the next seq to assign, and the full set of
  // filenames already recorded (txtMetadata.catalog.name) so already-
  // ingested files get skipped.
  private async resolveExistingState(
    db: any,
    crypto: CryptoEngine,
    admin: AdminIdentity,
  ): Promise<{ nextSeq: number; existingNames: Set<string> }> {
    const rows = await collectAllPages<OwnedTxtRow>(async (after) => {
      const offset = (after as number | undefined) ?? 0;
      const result = await db.query({
        txt: {
          $: {
            where: { "owner.id": admin.authId },
            order: { seq: "asc" },
            limit: C.INSTAQL_QUERY_PAGE_SIZE,
            offset,
          },
          txtMetadata: { $: { fields: ["catalog"] } },
        },
      });
      const page = result.txt ?? [];
      return {
        rows: page,
        hasNextPage: page.length === C.INSTAQL_QUERY_PAGE_SIZE,
        endCursor: offset + page.length,
      };
    });

    let maxSeq = 0;
    const existingNames = new Set<string>();
    for (const row of rows) {
      if (typeof row.seq === "number" && row.seq > maxSeq) maxSeq = row.seq;
      const metadata = row.txtMetadata?.[0];
      if (!row.txtKey || !metadata?.catalog) continue;
      try {
        const txtKey = crypto.blobDecrypt(
          admin.umk,
          Buffer.from(row.txtKey, "base64"),
          false,
        );
        const catalog = JSON.parse(
          crypto
            .blobDecrypt(txtKey, Buffer.from(metadata.catalog, "base64"), true)
            .toString("utf8"),
        );
        if (typeof catalog?.name === "string") existingNames.add(catalog.name);
      } catch (err) {
        this.log.warn(
          `txt=${row.id}: failed to decrypt catalog for the dedup check -- won't be skipped by name: ${errMsg(err)}`,
        );
      }
    }
    this.log.info(
      `Found ${rows.length} existing document(s), ${existingNames.size} name(s) known for dedup, next seq=${maxSeq + 1}`,
    );
    return { nextSeq: maxSeq + 1, existingNames };
  }

  private listSourceFiles(srcDir: string): string[] {
    return readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".txt"))
      .map((e) => join(srcDir, e.name))
      .sort();
  }

  // Skips any file whose name is already recorded in an owned document's
  // txtMetadata.catalog.name -- this is the whole of --ingest's
  // resumability: a rerun over the same directory only processes files
  // that weren't already fully ingested (a failed file's name never made
  // it into a committed txtMetadata row, so it's retried from scratch).
  private filterNewFiles(
    files: string[],
    existingNames: Set<string>,
  ): { toIngest: string[]; skipped: string[] } {
    const toIngest: string[] = [];
    const skipped: string[] = [];
    for (const filePath of files) {
      const name = basename(filePath);
      if (existingNames.has(name)) skipped.push(name);
      else toIngest.push(filePath);
    }
    return { toIngest, skipped };
  }

  private metadataContent(
    name: string,
    opfPath: string | null,
  ): TxtMetadataContent {
    const payload: TxtMetadataContent = { name };
    if (opfPath === null) return payload;
    const metadata = parseOpfMetadata(opfPath);
    if (Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
      this.log.info(
        `${name}: found OPF sidecar ${opfPath} (${Object.keys(metadata).length} field(s))`,
      );
    }
    return payload;
  }

  // Reads, splits, and uploads one file's parts, then -- only if every part
  // succeeded -- commits the txt/txtMetadata/txtParts rows in one
  // db.transact(). Returns null (never throws for these two known failure
  // points) if the upload or the transact fails, so run()'s loop can log
  // and move on to the next file rather than aborting the whole run.
  private async ingestOneFile(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    admin: AdminIdentity,
    filePath: string,
    seq: number,
  ): Promise<IngestedDoc | null> {
    const name = basename(filePath);
    const rawParts = splitParts(readFileSync(filePath));
    this.log.info(`${name}: ${rawParts.length} part(s)`);

    const txtKey = randomBytes(C.RANDOM_KEY_LEN);
    const prefix = generateRandomToken();
    const prefixHash = computePrefixHash(prefix);
    const txtId = id();

    let uploaded: UploadedPart[];
    try {
      uploaded = await this.uploadParts(r2, crypto, txtKey, prefix, rawParts);
    } catch (err) {
      this.log.warn(
        `${name}: part upload failed, skipping this file -- already-uploaded ` +
          `part(s) are left for --clean-bucket to sweep: ${errMsg(err)}`,
      );
      return null;
    }

    const content = this.metadataContent(name, findOpfSidecar(filePath));
    const txs = [
      tx
        .txt![txtId]!.update({
          txtKey: crypto
            .blobEncrypt(admin.umk, txtKey, false)
            .toString("base64"),
          prefix: wrapToken(crypto, txtKey, prefix),
          prefixHash,
          seq,
        })
        .link({ owner: admin.authId }),
      tx
        .txtMetadata![id()]!.update({
          content: crypto
            .blobEncrypt(
              txtKey,
              Buffer.from(JSON.stringify(content), "utf8"),
              true,
            )
            .toString("base64"),
          catalog: wrapCatalogBlob(
            crypto,
            txtKey,
            catalogFromMetadataContent(content),
          ),
        })
        .link({ txt: txtId, owner: admin.authId }),
      ...uploaded.map(({ partNum, path, txtPartKeyBlob }) =>
        tx
          .txtParts![id()]!.update({
            partNum,
            txtPartKey: txtPartKeyBlob,
            path,
            partKey: `${txtId}:${partNum}`,
          })
          .link({ txt: txtId, owner: admin.authId }),
      ),
    ];

    try {
      await db.transact(txs);
    } catch (err) {
      this.log.warn(
        `${name}: db.transact failed after every part uploaded -- already-uploaded ` +
          `part(s) are left for --clean-bucket to sweep: ${errMsg(err)}`,
      );
      return null;
    }

    this.log.info(
      `Ingested ${name} as txt_id=${txtId} (${uploaded.length} part(s), seq=${seq})`,
    );
    return { name, txtId, partCount: uploaded.length };
  }

  // Pure prep (fresh txtPartKey/raw_key/ciphertext per part, no I/O) up
  // front, then the real R2 PUTs R2_BATCH_CONCURRENCY at a time -- same
  // bounded-parallelism pattern this codebase's other bulk R2 writers use.
  // Cleaning (preprocessText) happens here, per part, not on the whole file
  // up front -- splitParts already ran against the raw file bytes.
  private async uploadParts(
    r2: R2Client,
    crypto: CryptoEngine,
    txtKey: Buffer,
    prefix: string,
    rawParts: Buffer[],
  ): Promise<UploadedPart[]> {
    const prepared = rawParts.map((raw, i) => {
      const partNum = i + 1;
      const cleaned = preprocessText(raw);
      const compressed = brotliCompressSync(cleaned, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: C.BROTLI_QUALITY },
      });
      const txtPartKey = randomBytes(C.RANDOM_KEY_LEN);
      const rawKey = generateRandomToken();
      const rawPath = `${prefix}/${rawKey}`;
      const ciphertext = crypto.blobEncrypt(txtPartKey, compressed, false);
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

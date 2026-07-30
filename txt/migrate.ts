// Orchestrates --migrate: decrypt the old shared-vault schema, re-encrypt
// each part's content under a fresh per-document key at a fresh R2/S3 path,
// build the new user's SQLCipher database, then chop it into pages and
// seed a new rqlite_txt.db under a freshly generated admin account.

import { randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { loadInCreds, loadOutCreds, rootKeyBytes } from "./creds.ts";
import { BlobCipher } from "./blobCipher.ts";
import { R2Client } from "./r2.ts";
import {
  OldVault,
  resolveTxtMetadataMap,
  type OldTxtRow,
  type OldPartRow,
  type TxtMetadataMap,
} from "./oldVault.ts";
import { UserDb } from "./userDb.ts";
import { RqliteDb, type RateTier } from "./rqliteDb.ts";
import { randomPath } from "./base32.ts";
import { mapLimit } from "./concurrency.ts";

const PART_CONCURRENCY = 16;
const DEFAULT_RATE_TIER: RateTier = { tierId: "free", rate: 10, burst: 20 };

export interface MigrateOptions {
  inCredsPath: string;
  inPath: string;
  outCredsPath: string;
  outPath: string;
  noDelete: boolean;
  verbose: boolean;
}

interface Summary {
  documents: number;
  partsMigrated: number;
  partsFailed: number;
}

export class MigrateCommand {
  private readonly opts: MigrateOptions;
  private readonly summary: Summary = { documents: 0, partsMigrated: 0, partsFailed: 0 };
  private readonly metadataCache = new Map<bigint, TxtMetadataMap>();
  private cipher!: BlobCipher;
  private r2!: R2Client;
  private oldVault!: OldVault;
  private userDb!: UserDb;

  constructor(opts: MigrateOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const inCreds = loadInCreds(this.opts.inCredsPath);
    const outCreds = loadOutCreds(this.opts.outCredsPath);
    this.cipher = await BlobCipher.create();
    this.r2 = new R2Client(inCreds.r2_config);
    this.oldVault = await OldVault.open(this.opts.inPath);
    this.userDb = await UserDb.create(rootKeyBytes(outCreds));
    const umks = this.oldVault.findDecryptableUmks(this.cipher, rootKeyBytes(inCreds));
    if (umks.size === 0)
      throw new Error("no umk_store row decrypted with the supplied user_root_key");
    await this.migrateAll(umks);
    this.oldVault.close();
    await this.writeOutput();
    this.report();
  }

  private async migrateAll(umks: Map<bigint, Buffer>): Promise<void> {
    const rows = this.oldVault.listTxt(new Set(umks.keys()));
    for (const row of rows) {
      await this.migrateDocument(row, umks.get(row.userId)!);
      this.summary.documents++;
      if (this.opts.verbose) {
        console.log(`migrated txt ${row.txtId} (${this.summary.documents}/${rows.length})`);
      }
    }
  }

  private async migrateDocument(row: OldTxtRow, umk: Buffer): Promise<void> {
    const oldTxtKey = this.cipher.decrypt(umk, row.txtKeyBlob);
    const metadataMap = await this.metadataFor(row.userId, umk);
    const entry = metadataMap[String(row.txtId)] ?? { name: `untitled-${row.txtId}` };
    const newTxtKey = randomBytes(128);
    const metadataBuf = entry.metadata
      ? brotliCompressSync(Buffer.from(JSON.stringify(entry.metadata)))
      : null;
    const newTxtId = this.userDb.insertTxt(newTxtKey, entry.name, metadataBuf, Date.now());
    const parts = this.oldVault.listParts(row.txtId);
    await mapLimit(parts, PART_CONCURRENCY, (part) =>
      this.migratePart(part, newTxtId, oldTxtKey, newTxtKey),
    );
  }

  private async metadataFor(userId: bigint, umk: Buffer): Promise<TxtMetadataMap> {
    const cached = this.metadataCache.get(userId);
    if (cached) return cached;
    const raw = this.oldVault.metadataRaw(userId);
    const map = raw
      ? await resolveTxtMetadataMap(
          this.cipher,
          this.r2,
          this.cipher.decrypt(umk, raw.keyBlob),
          raw.content,
        )
      : {};
    this.metadataCache.set(userId, map);
    return map;
  }

  private async migratePart(
    part: OldPartRow,
    newTxtId: bigint,
    oldTxtKey: Buffer,
    newTxtKey: Buffer,
  ): Promise<void> {
    if (this.userDb.hasPart(newTxtId, part.partNum)) return;
    try {
      await this.reencryptPart(part, newTxtId, oldTxtKey, newTxtKey);
      this.summary.partsMigrated++;
    } catch (err) {
      this.summary.partsFailed++;
      console.error(
        `part ${part.partNum} of new txt_id ${newTxtId} failed:`,
        (err as Error).message,
      );
    }
  }

  private async reencryptPart(
    part: OldPartRow,
    newTxtId: bigint,
    oldTxtKey: Buffer,
    newTxtKey: Buffer,
  ): Promise<void> {
    const oldPath = this.cipher.decrypt(oldTxtKey, part.pathBlob).toString("ascii");
    const object = await this.r2.get(oldPath);
    const plaintext = brotliDecompressSync(this.cipher.decrypt(oldTxtKey, object));
    const newPath = randomPath();
    await this.r2.put(newPath, this.cipher.encrypt(newTxtKey, brotliCompressSync(plaintext)));
    this.userDb.insertPart(newTxtId, part.partNum, newPath);
    if (!this.opts.noDelete) await this.r2.delete(oldPath);
  }

  private async writeOutput(): Promise<void> {
    const finished = this.userDb.finish();
    const rqliteDb = await RqliteDb.create(this.opts.outPath);
    const { userId, apiKeyRaw } = rqliteDb.seedAdmin(DEFAULT_RATE_TIER);
    rqliteDb.writePages(userId, finished.pageSize, finished.bytes);
    rqliteDb.close();
    console.log(`\nnew admin user_id: ${userId}`);
    console.log(`new admin API key (save this now, it is never stored anywhere): ${apiKeyRaw}`);
  }

  private report(): void {
    console.log(
      `\nmigrated ${this.summary.documents} documents, ${this.summary.partsMigrated} parts ` +
        `(${this.summary.partsFailed} part failures)`,
    );
  }
}

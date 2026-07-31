// Orchestrates --migrate: decrypt the old shared-vault schema, re-encrypt
// each part's content under a fresh per-document key at a fresh R2/S3 path,
// build the new user's SQLCipher database, and commit it into rqlite_txt.db
// after every document finishes -- the temporary user database only ever
// lives in memory, so committing early and often is what makes a run
// resumable after a crash, not anything the in-memory side keeps track of.

import { randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { loadInCreds, loadOutCreds, rootKeyBytes, type OutCreds } from "./creds.ts";
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
import { RqliteDb } from "./rqliteDb.ts";
import { randomPath } from "./base32.ts";
import { mapLimit } from "./concurrency.ts";

const PART_CONCURRENCY = 16;

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
}

export class MigrateCommand {
  private readonly opts: MigrateOptions;
  private readonly summary: Summary = { documents: 0, partsMigrated: 0 };
  private readonly metadataCache = new Map<bigint, TxtMetadataMap>();
  private cipher!: BlobCipher;
  private r2!: R2Client;
  private oldVault!: OldVault;
  private userDb!: UserDb;
  private rqliteDb!: RqliteDb;
  private userId!: string;

  constructor(opts: MigrateOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const inCreds = loadInCreds(this.opts.inCredsPath);
    const outCreds = loadOutCreds(this.opts.outCredsPath);
    this.cipher = await BlobCipher.create();
    this.r2 = new R2Client(inCreds.r2_config);
    this.oldVault = await OldVault.open(this.opts.inPath);
    await this.openOutput(outCreds);
    try {
      const umks = this.oldVault.findDecryptableUmks(this.cipher, rootKeyBytes(inCreds));
      this.log(`decrypted ${umks.size} owner umk(s) with the supplied root key`);
      if (umks.size === 0)
        throw new Error("no umk_store row decrypted with the supplied user_root_key");
      await this.migrateAll(umks);
    } finally {
      this.oldVault.close();
      this.rqliteDb.close();
    }
    this.report();
  }

  private async openOutput(outCreds: OutCreds): Promise<void> {
    this.rqliteDb = await RqliteDb.open(this.opts.outPath);
    const { userId, created } = this.rqliteDb.ensureAdmin(outCreds.api_key);
    this.userId = userId;
    const version = this.rqliteDb.currentVersion(userId);
    const rawKey = rootKeyBytes(outCreds);
    if (version === 0) {
      this.userDb = await UserDb.create(rawKey);
      this.commitProgress(); // baseline version 1 -- schema only, no documents yet
    } else {
      this.log(`resuming from existing output at version ${version}`);
      this.userDb = await UserDb.resume(rawKey, this.rqliteDb.latestPages(userId).bytes);
    }
    this.announceAdmin(userId, created);
  }

  private announceAdmin(userId: string, created: boolean): void {
    if (created) {
      console.log(
        `\nnew admin user_id: ${userId} (API key hash seeded from out_creds.json's api_key)`,
      );
    } else {
      this.log(`reusing existing admin user_id: ${userId} (API key hash refreshed)`);
    }
  }

  private async migrateAll(umks: Map<bigint, Buffer>): Promise<void> {
    const rows = this.oldVault.listTxt(new Set(umks.keys()));
    const alreadyDone = this.userDb.countTxt();
    if (alreadyDone > 0) this.log(`skipping ${alreadyDone} already-committed document(s)`);
    for (const row of rows.slice(alreadyDone)) {
      await this.migrateDocument(row, umks.get(row.userId)!);
      this.summary.documents++;
      this.log(
        `migrated txt ${row.txtId} (${alreadyDone + this.summary.documents}/${rows.length})`,
      );
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
    this.log(`txt ${row.txtId} -> ${newTxtId} "${entry.name}": migrating ${parts.length} part(s)`);
    const oldPaths = await mapLimit(parts, PART_CONCURRENCY, (part) =>
      this.migratePart(part, newTxtId, oldTxtKey, newTxtKey),
    );
    this.commitProgress();
    if (!this.opts.noDelete) await this.deleteOldObjects(oldPaths);
  }

  private commitProgress(): void {
    const snap = this.userDb.snapshot();
    this.rqliteDb.commit(this.userId, snap.pageSize, snap.bytes);
    this.log(
      `committed progress (${snap.pageCount} pages at version ${this.rqliteDb.currentVersion(this.userId)})`,
    );
  }

  private async deleteOldObjects(oldPaths: (string | null)[]): Promise<void> {
    const paths = oldPaths.filter((p): p is string => p !== null);
    await mapLimit(paths, PART_CONCURRENCY, async (oldPath) => {
      await this.r2.delete(oldPath);
      this.log(`  deleted old object ${oldPath}`);
    });
  }

  private async metadataFor(userId: bigint, umk: Buffer): Promise<TxtMetadataMap> {
    const cached = this.metadataCache.get(userId);
    if (cached) return cached;
    const raw = this.oldVault.metadataRaw(userId);
    this.log(`resolving metadata map for owner ${userId}${raw ? "" : " (none found)"}`);
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

  /**
   * Returns this part's old path on success (deletion is deferred until the
   * whole document commits), or null if there was nothing new to do. A
   * failure here propagates all the way up and aborts the run -- a document
   * only ever commits once every one of its parts has succeeded, so letting
   * one bad part abort cleanly (rather than silently leaving a document
   * partially migrated) is what keeps "resume" meaningful: whatever's
   * already committed is complete, and the rest just needs a re-run once
   * whatever caused the failure is fixed.
   */
  private async migratePart(
    part: OldPartRow,
    newTxtId: bigint,
    oldTxtKey: Buffer,
    newTxtKey: Buffer,
  ): Promise<string | null> {
    if (this.userDb.hasPart(newTxtId, part.partNum)) {
      this.log(`  part ${part.partNum}: already present, skipping`);
      return null;
    }
    return this.reencryptPart(part, newTxtId, oldTxtKey, newTxtKey);
  }

  private async reencryptPart(
    part: OldPartRow,
    newTxtId: bigint,
    oldTxtKey: Buffer,
    newTxtKey: Buffer,
  ): Promise<string> {
    const oldPath = this.cipher.decrypt(oldTxtKey, part.pathBlob).toString("ascii");
    this.log(`  part ${part.partNum}: downloading ${oldPath}`);
    const object = await this.r2.get(oldPath);
    const plaintext = brotliDecompressSync(this.cipher.decrypt(oldTxtKey, object));
    const newPath = randomPath();
    this.log(`  part ${part.partNum}: uploading ${newPath}`);
    await this.r2.put(newPath, this.cipher.encrypt(newTxtKey, brotliCompressSync(plaintext)));
    this.userDb.insertPart(newTxtId, part.partNum, newPath);
    this.summary.partsMigrated++;
    this.log(`  part ${part.partNum}: inserted (txt_id ${newTxtId})`);
    return oldPath;
  }

  private log(message: string): void {
    if (this.opts.verbose) console.log(message);
  }

  private report(): void {
    console.log(
      `\nmigrated ${this.summary.documents} documents, ${this.summary.partsMigrated} parts`,
    );
  }
}

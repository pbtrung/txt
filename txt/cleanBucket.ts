// --clean-bucket: deletes every R2/S3 object not referenced by any
// txt_parts.path in the migrated user's database. Read-only against
// rqlite_txt.db -- only the bucket is ever written to.

import { loadInCreds, rootKeyBytes } from "./creds.ts";
import { R2Client } from "./r2.ts";
import { RqliteDb } from "./rqliteDb.ts";
import { SqliteDb } from "./sqlite.ts";

export interface CleanBucketOptions {
  credsPath: string;
  dbPath: string;
  dryRun: boolean;
  verbose: boolean;
}

export class CleanBucketCommand {
  private readonly opts: CleanBucketOptions;

  constructor(opts: CleanBucketOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const creds = loadInCreds(this.opts.credsPath);
    const r2 = new R2Client(creds.r2_config);
    const referenced = await this.referencedPaths(rootKeyBytes(creds));
    this.log(`${referenced.size} object path(s) referenced by txt_parts`);
    const allKeys = await r2.list();
    this.log(`${allKeys.length} object(s) in the bucket`);
    const orphans = allKeys.filter((key) => !referenced.has(key));
    await this.handleOrphans(r2, orphans);
    this.report(allKeys.length, referenced.size, orphans.length);
  }

  private async referencedPaths(rawKey: Buffer): Promise<Set<string>> {
    const rqliteDb = await RqliteDb.openExisting(this.opts.dbPath, { readOnly: true });
    const userId = rqliteDb.findAdminUserId();
    if (!userId) {
      rqliteDb.close();
      return new Set();
    }
    const { bytes } = rqliteDb.latestPages(userId);
    rqliteDb.close();
    return this.readTxtPartPaths(bytes, rawKey);
  }

  private async readTxtPartPaths(bytes: Uint8Array, rawKey: Buffer): Promise<Set<string>> {
    const userDb = await SqliteDb.open("/clean-bucket-user.db", {
      preload: bytes,
      rawKey,
      readOnly: true,
    });
    const stmt = userDb.prepare("SELECT path FROM txt_parts;");
    const paths = new Set<string>();
    while (stmt.step()) paths.add(stmt.columnText(0));
    stmt.finalize();
    userDb.close();
    return paths;
  }

  private async handleOrphans(r2: R2Client, orphans: string[]): Promise<void> {
    for (const key of orphans) {
      if (this.opts.dryRun) {
        console.log(`would delete: ${key}`);
        continue;
      }
      await r2.delete(key);
      this.log(`deleted: ${key}`);
    }
  }

  private log(message: string): void {
    if (this.opts.verbose) console.log(message);
  }

  private report(total: number, referenced: number, orphanCount: number): void {
    const verb = this.opts.dryRun ? "would delete" : "deleted";
    console.log(
      `\n${total} object(s) in bucket, ${referenced} referenced, ${orphanCount} orphan(s) ${verb}`,
    );
  }
}

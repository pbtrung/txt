// --vacuum: rebuilds the admin's user SQLCipher database first (reclaiming
// space from deleted rows, defragmenting), commits the result back into
// rqlite_txt.db as a new version, then rebuilds rqlite_txt.db itself.

import { statSync } from "node:fs";
import { loadOutCreds, rootKeyBytes } from "./creds.ts";
import { RqliteDb } from "./rqliteDb.ts";
import { SqliteDb } from "./sqlite.ts";

export interface VacuumOptions {
  credsPath: string;
  dbPath: string;
  verbose: boolean;
}

export class VacuumCommand {
  private readonly opts: VacuumOptions;

  constructor(opts: VacuumOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const creds = loadOutCreds(this.opts.credsPath);
    const rqliteDb = await RqliteDb.openExisting(this.opts.dbPath);
    try {
      const userId = rqliteDb.findAdminUserId();
      if (!userId) {
        console.log("no admin account found; nothing to vacuum");
        return;
      }
      await this.vacuumUserDb(rqliteDb, userId, rootKeyBytes(creds));
      this.vacuumRqliteDb(rqliteDb);
    } finally {
      rqliteDb.close();
    }
  }

  private async vacuumUserDb(rqliteDb: RqliteDb, userId: string, rawKey: Buffer): Promise<void> {
    const before = rqliteDb.latestPages(userId);
    this.log(`user database: ${before.bytes.length} bytes before VACUUM`);
    const userDb = await SqliteDb.open("/vacuum-user.db", { preload: before.bytes, rawKey });
    userDb.exec("VACUUM;");
    const after = userDb.readBytes();
    userDb.close();
    this.log(`user database: ${after.length} bytes after VACUUM`);
    rqliteDb.commit(userId, before.pageSize, after);
  }

  private vacuumRqliteDb(rqliteDb: RqliteDb): void {
    const before = statSync(this.opts.dbPath).size;
    rqliteDb.vacuum();
    const after = statSync(this.opts.dbPath).size;
    console.log(`\nrqlite_txt.db: ${before} -> ${after} bytes`);
  }

  private log(message: string): void {
    if (this.opts.verbose) console.log(message);
  }
}

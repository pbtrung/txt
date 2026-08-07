// Orchestrates --collect-garbage: sweeps every document (`txt` row) this
// admin owns for orphaned R2 objects (docs/protocols.md's Garbage
// collection, Orphan sweep). There is no per-account page-version sweep to
// run in this design -- a `txtParts` row is written exactly once and never
// revised in place (docs/protocols.md's Ingest / write path), so there's no
// superseded-version cleanup for anything to leave behind -- and no
// cross-account escrow lookup either, since only the admin ever owns
// content (docs/data_model.md's Operating model): this tool only ever needs
// the admin's own identity, never another account's.
import { init } from "@instantdb/admin";
import { resolveAdmin, resolveOwnedDocuments } from "./adminScan.ts";
import { CryptoEngine } from "./crypto.ts";
import type { GcCreds } from "./gcCreds.ts";
import type { Logger } from "./logger.ts";
import { sweepOrphanObjects } from "./orphanSweep.ts";

export interface CollectGarbageOptions {
  dryRun: boolean;
  // Returns true to proceed. Called once, before touching any R2 object --
  // only in live mode (dry-run never deletes, so never needs to ask).
  confirm: (message: string) => Promise<boolean>;
}

export interface CollectGarbageResult {
  dryRun: boolean;
  documentCount: number;
  staleObjectsDeleted: number;
}

export class GarbageCollector {
  private creds: GcCreds;
  private log: Logger;

  constructor(creds: GcCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async run(opts: CollectGarbageOptions): Promise<CollectGarbageResult> {
    const crypto = await CryptoEngine.create();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    const admin = await resolveAdmin(db, crypto, this.creds, this.log);
    const targets = await resolveOwnedDocuments(db, crypto, admin, this.log);
    this.log.info(
      `Found ${targets.length} document(s) to sweep for orphaned R2 objects`,
    );
    if (targets.length > 0 && !opts.dryRun) {
      await this.confirmOrAbort(targets.length, opts.confirm);
    }
    const staleObjectsDeleted = await sweepOrphanObjects(
      admin.r2,
      targets,
      this.log,
      opts.dryRun,
    );
    return {
      dryRun: opts.dryRun,
      documentCount: targets.length,
      staleObjectsDeleted,
    };
  }

  private async confirmOrAbort(
    documentCount: number,
    confirm: CollectGarbageOptions["confirm"],
  ): Promise<void> {
    const message =
      `Garbage-collect ${documentCount} document(s): delete every untracked R2 object under ` +
      `each document's own prefix? This cannot be undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }
}

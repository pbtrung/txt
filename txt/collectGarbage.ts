// Orchestrates --collect-garbage: both of docs/data_model.md's Garbage
// collection sweeps, app-wide, one account at a time. Unlike --migrate
// (which only ever touches one account resolved via a live Firebase
// sign-in), this enumerates every account with a `dbMeta` row directly via
// the Admin SDK -- there's no per-account session to sign into, so recovering
// a non-admin account's own path_key goes through credStore's third row
// shape (owner = admin, user = that account, content = that account's own
// user_root_key, wrapped under the admin's own umk).
//
// Deliberate simplification of sweep 1's full design: this always keeps
// only the single current dbMeta.currentVersion, without checking whether
// any activeReaders row still needs an older one -- --collect-garbage is a
// manually-run maintenance operation, not a background job expected to race
// live readers.
import { init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { loadR2Config, type R2ConfigResolved } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import type { GcCreds } from "./gcCreds.ts";
import { collectAllPages } from "./instaqlPagination.ts";
import type { Logger } from "./logger.ts";
import { computeR2Prefix, decodePagePointerContent } from "./pagePointer.ts";
import { R2Client } from "./r2.ts";

export interface CollectGarbageOptions {
  dryRun: boolean;
  // Returns true to proceed. Called once, before touching any account --
  // only in live mode (dry-run never deletes, so never needs to ask).
  confirm: (message: string) => Promise<boolean>;
}

export interface AccountGcResult {
  authId: string;
  skipped: string | null;
  oldPagesDeleted: number;
  staleObjectsDeleted: number;
}

export interface CollectGarbageResult {
  dryRun: boolean;
  accounts: AccountGcResult[];
}

interface AdminIdentity {
  authId: string;
  umk: Buffer;
  pathKey: Buffer;
  r2: R2Client;
}

interface AccountRow {
  ownerId: string;
  dbMetaId: string;
  currentVersion: number;
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
    const admin = await this.resolveAdmin(db, crypto);
    const accounts = await this.listAccounts(db);
    this.log.info(`Found ${accounts.length} account(s) to garbage-collect`);
    if (!opts.dryRun) {
      await this.confirmOrAbort(accounts.length, opts.confirm);
    }
    const results: AccountGcResult[] = [];
    for (const account of accounts) {
      results.push(
        await this.processAccount(db, crypto, admin, account, opts.dryRun),
      );
    }
    return { dryRun: opts.dryRun, accounts: results };
  }

  // Finds the one $users row (type: "admin") whose umk actually decrypts
  // under this creds.json's own user_root_key -- there's no other way to
  // know which admin row it belongs to without trying each candidate (AEAD
  // tag verification fails hard on a wrong key, so this is safe: exactly
  // one candidate can ever succeed). Then unwraps that account's own
  // credStore self-row for its real, read-write r2_config and path_key.
  // That r2_config -- a single, shared real R2 credential -- is reused for
  // every account's R2 operations below; only path_key is genuinely
  // per-account.
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
        const { pathKey, r2Config } = await this.resolveOwnCredStore(
          db,
          crypto,
          row.id,
          umk,
        );
        this.log.info(`Resolved admin identity: auth.id=${row.id}`);
        return {
          authId: row.id,
          umk,
          pathKey,
          r2: new R2Client(r2Config, false, this.log),
        };
      } catch {
        // Wrong admin candidate for this user_root_key -- try the next one.
      }
    }
    throw new Error(
      `no admin $users row's umk decrypts under this creds.json's user_root_key ` +
        `(tried ${candidates.length} candidate(s))`,
    );
  }

  // Decrypts an account's own credStore self-row (owner = user = this
  // account, docs/data_model.md's credStore entity) given its already-
  // unwrapped umk.
  private async resolveOwnCredStore(
    db: any,
    crypto: CryptoEngine,
    ownerId: string,
    umk: Buffer,
  ): Promise<{ pathKey: Buffer; r2Config: R2ConfigResolved }> {
    const result = await db.query({
      credStore: {
        $: { where: { "owner.id": ownerId, "user.id": ownerId } },
      },
    });
    const row = result.credStore?.[0];
    if (!row) throw new Error(`no own credStore row for auth.id=${ownerId}`);
    const payload = JSON.parse(
      crypto
        .blobDecrypt(umk, Buffer.from(row.content, "base64"), true)
        .toString("utf8"),
    );
    return {
      pathKey: Buffer.from(payload.path_key, "base64"),
      r2Config: loadR2Config(payload),
    };
  }

  // For a non-admin account: the admin holds its own encrypted copy of that
  // account's user_root_key (credStore's third row shape, docs/data_model.md
  // -- owner = admin, user = that account). Decrypt it under the admin's own
  // umk, use it to unwrap that account's own $users.umk, then that account's
  // own credStore self-row for its path_key. Returns null if the admin-held
  // copy doesn't exist yet for this account (e.g. it was provisioned before
  // this mechanism existed, or by something that never wrote one) -- the
  // caller skips that account rather than failing the whole run.
  private async resolvePathKeyForOther(
    db: any,
    crypto: CryptoEngine,
    admin: AdminIdentity,
    ownerId: string,
  ): Promise<Buffer | null> {
    const copyResult = await db.query({
      credStore: {
        $: { where: { "owner.id": admin.authId, "user.id": ownerId } },
      },
    });
    const copyRow = copyResult.credStore?.[0];
    if (!copyRow) return null;
    const copyPayload = JSON.parse(
      crypto
        .blobDecrypt(admin.umk, Buffer.from(copyRow.content, "base64"), true)
        .toString("utf8"),
    );
    const userRootKey = Buffer.from(copyPayload.user_root_key, "base64");
    const usersResult = await db.query({
      $users: { $: { where: { id: ownerId } } },
    });
    const usersRow = usersResult.$users?.[0];
    if (!usersRow?.umk) return null;
    const umk = crypto.blobDecrypt(
      userRootKey,
      Buffer.from(usersRow.umk, "base64"),
      false,
    );
    const { pathKey } = await this.resolveOwnCredStore(
      db,
      crypto,
      ownerId,
      umk,
    );
    return pathKey;
  }

  // Every provisioned account -- one dbMeta row each. Not paginated: the
  // number of *accounts* is expected to stay small (unlike the number of
  // pages within any one of them, which does need pagination below).
  private async listAccounts(db: any): Promise<AccountRow[]> {
    const result = await db.query({ dbMeta: { owner: {} } });
    return (result.dbMeta ?? []).map((row: any) => ({
      ownerId: row.owner[0].id,
      dbMetaId: row.id,
      currentVersion: row.currentVersion,
    }));
  }

  private async confirmOrAbort(
    accountCount: number,
    confirm: CollectGarbageOptions["confirm"],
  ): Promise<void> {
    const message =
      `Garbage-collect ${accountCount} account(s): delete every superseded page-store version ` +
      `(keeping only each account's current dbMeta.currentVersion) and every untracked R2 object ` +
      `under each account's own prefix? This cannot be undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  private async processAccount(
    db: any,
    crypto: CryptoEngine,
    admin: AdminIdentity,
    account: AccountRow,
    dryRun: boolean,
  ): Promise<AccountGcResult> {
    const pathKey =
      account.ownerId === admin.authId
        ? admin.pathKey
        : await this.resolvePathKeyForOther(db, crypto, admin, account.ownerId);
    if (!pathKey) {
      this.log.warn(
        `auth.id=${account.ownerId}: no admin-held credStore copy of its user_root_key yet -- skipping`,
      );
      return {
        authId: account.ownerId,
        skipped: "no admin-held credStore copy of user_root_key",
        oldPagesDeleted: 0,
        staleObjectsDeleted: 0,
      };
    }
    const r2Prefix = computeR2Prefix(account.ownerId);
    const oldPagesDeleted = await this.sweepOldVersions(
      db,
      admin.r2,
      crypto,
      pathKey,
      r2Prefix,
      account,
      dryRun,
    );
    const staleObjectsDeleted = await this.sweepStaleObjects(
      db,
      admin.r2,
      crypto,
      pathKey,
      r2Prefix,
      account.ownerId,
      dryRun,
    );
    this.log.info(
      `auth.id=${account.ownerId}: ${oldPagesDeleted} old page-version(s), ` +
        `${staleObjectsDeleted} stale R2 object(s) ${dryRun ? "would be " : ""}deleted`,
    );
    return {
      authId: account.ownerId,
      skipped: null,
      oldPagesDeleted,
      staleObjectsDeleted,
    };
  }

  // Sweep 1: every `pages` row older than this account's current
  // dbMeta.currentVersion, plus the R2 object each one's decrypted path
  // resolves to. Batched S3_DELETE_BATCH_SIZE at a time (same batch size R2's
  // own DeleteObjects uses) -- within each batch, delete that batch's pages
  // rows first, then that batch's R2 objects, in that order, so a crash
  // mid-batch never leaves a pages row pointing at something already deleted
  // (a stray object with no row left behind is caught by sweepStaleObjects
  // below instead). Paired per batch rather than deleting every pages row in
  // one pass and every R2 object in a separate, later pass.
  private async sweepOldVersions(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    pathKey: Buffer,
    r2Prefix: string,
    account: AccountRow,
    dryRun: boolean,
  ): Promise<number> {
    const rows = await collectAllPages<{ id: string; path: string }>(
      async (after) => {
        const result = await db.query({
          pages: {
            $: {
              where: {
                "owner.id": account.ownerId,
                version: { $lt: account.currentVersion },
              },
              order: { pageKey: "asc" },
              limit: C.PAGES_QUERY_PAGE_SIZE,
              ...(after ? { after } : {}),
            },
          },
        });
        const pageInfo = result.pageInfo?.pages;
        return {
          rows: result.pages ?? [],
          hasNextPage: !!pageInfo?.hasNextPage,
          endCursor: pageInfo?.endCursor,
        };
      },
    );
    if (rows.length === 0 || dryRun) return rows.length;
    for (let i = 0; i < rows.length; i += C.S3_DELETE_BATCH_SIZE) {
      const batch = rows.slice(i, i + C.S3_DELETE_BATCH_SIZE);
      await db.transact(batch.map((row) => tx.pages[row.id].delete()));
      const rawPaths = batch.map(
        (row) =>
          `${r2Prefix}/${decodePagePointerContent(crypto, pathKey, Buffer.from(row.path, "base64"))}`,
      );
      const result = await r2.deleteObjects(rawPaths);
      for (const err of result.errors) {
        this.log.warn(
          `Failed to delete old page object ${err.key}: ${err.message}`,
        );
      }
      this.log.info(
        `auth.id=${account.ownerId}: batch of ${batch.length} old page(s) -- ` +
          `${batch.length} pages row(s) deleted from InstantDB, ` +
          `${result.deletedKeys.size} R2 object(s) deleted`,
      );
    }
    return rows.length;
  }

  // Sweep 2: after sweepOldVersions above, every remaining `pages` row for
  // this account is its current version -- so any R2 object under this
  // account's own prefix not resolved to by one of those rows is either a
  // leftover from a crashed commit (docs/data_model.md's commit-protocol
  // failure mode) or from a sweepOldVersions run that itself crashed
  // between its own two delete steps.
  private async sweepStaleObjects(
    db: any,
    r2: R2Client,
    crypto: CryptoEngine,
    pathKey: Buffer,
    r2Prefix: string,
    ownerId: string,
    dryRun: boolean,
  ): Promise<number> {
    const [objects, known] = await Promise.all([
      r2.listAllObjects(`${r2Prefix}/`),
      this.collectKnownRawPaths(db, crypto, pathKey, r2Prefix, ownerId),
    ]);
    const stale = objects.filter((o) => !known.has(o.key));
    if (stale.length === 0 || dryRun) return stale.length;
    const result = await r2.deleteObjects(stale.map((o) => o.key));
    for (const err of result.errors) {
      this.log.warn(`Failed to delete stale object ${err.key}: ${err.message}`);
    }
    // R2-only, deliberately: these objects have no pages row pointing to
    // them at all (that's the definition of "stale" here), so there's
    // nothing to delete on the InstantDB side -- unlike sweepOldVersions
    // above, which deletes a pages row and its R2 object together.
    this.log.info(
      `auth.id=${ownerId}: ${result.deletedKeys.size} stale R2 object(s) deleted (no pages rows involved)`,
    );
    return result.deletedKeys.size;
  }

  private async collectKnownRawPaths(
    db: any,
    crypto: CryptoEngine,
    pathKey: Buffer,
    r2Prefix: string,
    ownerId: string,
  ): Promise<Set<string>> {
    const rows = await collectAllPages<{ path: string }>(async (after) => {
      const result = await db.query({
        pages: {
          $: {
            where: { "owner.id": ownerId },
            order: { pageKey: "asc" },
            limit: C.PAGES_QUERY_PAGE_SIZE,
            ...(after ? { after } : {}),
          },
        },
      });
      const pageInfo = result.pageInfo?.pages;
      return {
        rows: result.pages ?? [],
        hasNextPage: !!pageInfo?.hasNextPage,
        endCursor: pageInfo?.endCursor,
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

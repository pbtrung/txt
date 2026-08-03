// The read/write primitives from docs/data_model.md's Read protocol and
// Commit protocol: resolving a page's current path and fetching its bytes
// from R2, and uploading dirty pages (real R2 PUT, then one transact()
// writing pages.path directly and CAS-bumping dbMeta -- no separate
// pointer-row upload). Talks to InstantDB via the admin SDK (bypasses
// permission rules entirely) -- fine for --init-admin's one-time,
// single-writer bootstrap, but a live multi-device app would need the CAS
// retry loop the docs flag as unverified (dbMeta.currentVersion ==
// data.currentVersion + 1), which only applies to rule-checked writes from
// an authenticated session, not admin-SDK ones. Not implemented here.
import { id, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import type { CryptoEngine } from "./crypto.ts";
import {
  computeR2Prefix,
  decodePagePointerContent,
  encodePagePointerContent,
  generateRawKey,
} from "./pagePointer.ts";
import type { R2Client } from "./r2.ts";

export interface RemotePageStoreConfig {
  db: any; // @instantdb/admin database instance
  r2: R2Client;
  crypto: CryptoEngine;
  pathKey: Buffer;
  authId: string; // $users id -- pageKey identity, R2 prefix, and pages/dbMeta owner link target
}

export interface CommitResult {
  newVersion: number;
  pageCount: number;
}

// The pure (no I/O) half of uploading a page -- rawPath/pageKey/the encrypted
// path are all derivable from the page bytes and this store's own config, so
// every page can be prepared up front before any network call. The encrypted
// path only ever wraps rawKey (the random suffix) -- rawPath (the full R2
// object address, prefix included) is what the actual PUT needs, but the
// prefix itself is never part of what gets encrypted, since it's already
// derivable from authId at read time.
interface PreparedUpload {
  pageNo: number;
  pageKey: string;
  rawPath: string;
  body: Buffer;
  path: string; // base64 -- goes directly onto the pages row
}

export class RemotePageStore {
  private cfg: RemotePageStoreConfig;

  constructor(cfg: RemotePageStoreConfig) {
    this.cfg = cfg;
  }

  async fetchPage(pageNo: number, targetVersion: number): Promise<Buffer> {
    const path = await this.resolvePagePath(pageNo, targetVersion);
    const rawKey = decodePagePointerContent(
      this.cfg.crypto,
      this.cfg.pathKey,
      Buffer.from(path, "base64"),
    );
    const rawPath = `${computeR2Prefix(this.cfg.authId)}/${rawKey}`;
    return this.cfg.r2.getObject(rawPath);
  }

  private async resolvePagePath(
    pageNo: number,
    targetVersion: number,
  ): Promise<string> {
    const result = await this.cfg.db.query({
      pages: {
        $: {
          where: {
            "owner.id": this.cfg.authId,
            pageNo,
            version: { $lte: targetVersion },
          },
          order: { version: "desc" },
          limit: 1,
        },
      },
    });
    const row = result.pages?.[0];
    if (!row)
      throw new Error(
        `no page row for pageNo=${pageNo} version<=${targetVersion}`,
      );
    return row.path;
  }

  // Uploads every dirty page as a new version (all sharing one new version
  // number, per the commit protocol) and CAS-bumps dbMeta in the same
  // transact() that creates the new pages rows.
  async commitPages(
    dirtyPages: Map<number, Buffer>,
    dbMetaId: string,
    currentVersion: number,
    pageCount: number,
    pageSize: number,
  ): Promise<CommitResult> {
    const newVersion = currentVersion + 1;
    const prepared = this.preparePages(dirtyPages, newVersion);
    await this.uploadPages(prepared);
    await this.transactPages(
      prepared,
      newVersion,
      dbMetaId,
      pageCount,
      pageSize,
    );
    return { newVersion, pageCount };
  }

  private preparePages(
    dirtyPages: Map<number, Buffer>,
    version: number,
  ): PreparedUpload[] {
    return [...dirtyPages].map(([pageNo, body]) => {
      const pageKey = `${this.cfg.authId}:${pageNo}:${version}`;
      const rawKey = generateRawKey();
      const rawPath = `${computeR2Prefix(this.cfg.authId)}/${rawKey}`;
      const path = encodePagePointerContent(
        this.cfg.crypto,
        this.cfg.pathKey,
        rawKey,
      ).toString("base64");
      return { pageNo, pageKey, rawPath, body, path };
    });
  }

  // Issues the real R2 PUTs R2_BATCH_CONCURRENCY at a time -- bounded
  // parallelism instead of one page at a time (slow for anything beyond a
  // handful of pages) or all of them at once (risks exhausting connections /
  // R2 rate limits, especially for a bulk --migrate commit). The one failure
  // mode this leaves (docs/data_model.md's commit protocol): a crash between
  // a page's PUT here and the transact() below leaves an untracked R2
  // object, never a pages row pointing at something that was never written.
  private async uploadPages(prepared: PreparedUpload[]): Promise<void> {
    for (let i = 0; i < prepared.length; i += C.R2_BATCH_CONCURRENCY) {
      const batch = prepared.slice(i, i + C.R2_BATCH_CONCURRENCY);
      await Promise.all(
        batch.map((p) => this.cfg.r2.putObject(p.rawPath, p.body)),
      );
    }
  }

  private async transactPages(
    prepared: PreparedUpload[],
    newVersion: number,
    dbMetaId: string,
    pageCount: number,
    pageSize: number,
  ): Promise<void> {
    const pageTxs = prepared.map((p) => this.pageTx(p, newVersion));
    const dbMetaTx = tx.dbMeta[dbMetaId]
      .update({
        currentVersion: newVersion,
        pageCount,
        pageSize,
        needsGc: false,
      })
      .link({ owner: this.cfg.authId }); // idempotent if already linked
    await this.cfg.db.transact([...pageTxs, dbMetaTx]);
  }

  private pageTx(p: PreparedUpload, version: number) {
    return tx.pages[id()]
      .update({ pageKey: p.pageKey, pageNo: p.pageNo, version, path: p.path })
      .link({ owner: this.cfg.authId });
  }
}

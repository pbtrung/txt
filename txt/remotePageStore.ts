// The read/write primitives from docs/data_model.md's Read protocol and
// Commit protocol: resolving a page's current pointer and fetching its bytes
// from R2, and uploading dirty pages (real R2 PUT + $files pointer +
// pages/dbMeta transact). Talks to InstantDB via the admin SDK (bypasses
// permission rules entirely) -- fine for --init-admin's one-time,
// single-writer bootstrap, but a live multi-device app would need the CAS
// retry loop the docs flag as unverified (dbMeta.currentVersion ==
// data.currentVersion + 1), which only applies to rule-checked writes from
// an authenticated session, not admin-SDK ones. Not implemented here.
import { id, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import type { CryptoEngine } from "./crypto.ts";
import {
  decodePagePointerContent,
  encodePagePointerContent,
  generateRawPath,
} from "./pagePointer.ts";
import type { R2Client } from "./r2.ts";

export interface RemotePageStoreConfig {
  db: any; // @instantdb/admin database instance
  r2: R2Client;
  crypto: CryptoEngine;
  pathKey: Buffer;
  authId: string; // $users id -- pageKey identity and (via generateRawPath) R2 prefix
  ownerId: string; // `users` profile row id -- pages/dbMeta owner link target
}

export interface CommitResult {
  newVersion: number;
  pageCount: number;
}

interface UploadedPage {
  fileId: string;
  pageKey: string;
}

// The pure (no I/O) half of uploading a page -- rawPath/pageKey/the encrypted
// pointer content are all derivable from the page bytes and this store's own
// config, so every page can be prepared up front before any network call.
interface PreparedUpload {
  pageNo: number;
  pageKey: string;
  rawPath: string;
  body: Buffer;
  content: Buffer;
}

export class RemotePageStore {
  private cfg: RemotePageStoreConfig;

  constructor(cfg: RemotePageStoreConfig) {
    this.cfg = cfg;
  }

  async fetchPage(pageNo: number, targetVersion: number): Promise<Buffer> {
    const url = await this.resolvePagePointerUrl(pageNo, targetVersion);
    const content = await this.downloadPointerContent(url);
    const rawPath = decodePagePointerContent(
      this.cfg.crypto,
      this.cfg.pathKey,
      content,
    );
    return this.cfg.r2.getObject(rawPath);
  }

  private async resolvePagePointerUrl(
    pageNo: number,
    targetVersion: number,
  ): Promise<string> {
    const result = await this.cfg.db.query({
      pages: {
        $: {
          where: {
            "owner.id": this.cfg.ownerId,
            pageNo,
            version: { $lte: targetVersion },
          },
          order: { version: "desc" },
          limit: 1,
        },
        pointerFile: {},
      },
    });
    const row = result.pages?.[0];
    if (!row)
      throw new Error(
        `no page row for pageNo=${pageNo} version<=${targetVersion}`,
      );
    return row.pointerFile[0].url;
  }

  private async downloadPointerContent(url: string): Promise<Buffer> {
    const resp = await fetch(url);
    if (!resp.ok)
      throw new Error(
        `failed to download $files pointer content: HTTP ${resp.status}`,
      );
    return Buffer.from(await resp.arrayBuffer());
  }

  // Uploads every dirty page as a new version (all sharing one new version
  // number, per the commit protocol) and CAS-bumps dbMeta in one transact.
  async commitPages(
    dirtyPages: Map<number, Buffer>,
    dbMetaId: string,
    currentVersion: number,
    pageCount: number,
    pageSize: number,
  ): Promise<CommitResult> {
    const newVersion = currentVersion + 1;
    const uploaded = await this.uploadPages(dirtyPages, newVersion);
    await this.transactPages(
      uploaded,
      newVersion,
      dbMetaId,
      pageCount,
      pageSize,
    );
    return { newVersion, pageCount };
  }

  // Prepares every dirty page (pure -- rawPath generation + pointer
  // encryption, no I/O) up front, then issues the actual R2 PUT / $files
  // upload round-trips R2_BATCH_CONCURRENCY at a time -- bounded parallelism
  // instead of one page at a time (slow for anything beyond a handful of
  // pages) or all of them at once (risks exhausting connections / R2 rate
  // limits, especially for a bulk --migrate commit).
  private async uploadPages(
    dirtyPages: Map<number, Buffer>,
    version: number,
  ): Promise<Map<number, UploadedPage>> {
    const prepared = this.preparePages(dirtyPages, version);
    const uploaded = new Map<number, UploadedPage>();
    for (let i = 0; i < prepared.length; i += C.R2_BATCH_CONCURRENCY) {
      const batch = prepared.slice(i, i + C.R2_BATCH_CONCURRENCY);
      const results = await Promise.all(batch.map((p) => this.uploadOne(p)));
      batch.forEach((p, idx) => uploaded.set(p.pageNo, results[idx]));
    }
    return uploaded;
  }

  private preparePages(
    dirtyPages: Map<number, Buffer>,
    version: number,
  ): PreparedUpload[] {
    return [...dirtyPages].map(([pageNo, body]) => {
      const pageKey = `${this.cfg.authId}:${pageNo}:${version}`;
      const rawPath = generateRawPath(this.cfg.authId);
      const content = encodePagePointerContent(
        this.cfg.crypto,
        this.cfg.pathKey,
        rawPath,
      );
      return { pageNo, pageKey, rawPath, body, content };
    });
  }

  // R2 PUT before the $files upload, same order within one page as before --
  // matches the commit protocol (docs/data_model.md): if this crashes
  // between the two, the result is an untracked R2 object (the GC design's
  // "untracked R2 objects" sweep already accounts for this), never a $files
  // pointer referencing an R2 object that was never written.
  private async uploadOne(p: PreparedUpload): Promise<UploadedPage> {
    await this.cfg.r2.putObject(p.rawPath, p.body);
    const { data } = await this.cfg.db.storage.uploadFile(p.pageKey, p.content);
    return { fileId: data.id, pageKey: p.pageKey };
  }

  private async transactPages(
    uploaded: Map<number, UploadedPage>,
    newVersion: number,
    dbMetaId: string,
    pageCount: number,
    pageSize: number,
  ): Promise<void> {
    const pageTxs = [...uploaded].map(([pageNo, info]) =>
      this.pageTx(pageNo, info, newVersion),
    );
    const fileOwnerTxs = [...uploaded.values()].map((info) =>
      this.fileTx(info),
    );
    const dbMetaTx = tx.dbMeta[dbMetaId]
      .update({
        currentVersion: newVersion,
        pageCount,
        pageSize,
        needsGc: false,
      })
      .link({ owner: this.cfg.ownerId }); // idempotent if already linked
    await this.cfg.db.transact([...pageTxs, ...fileOwnerTxs, dbMetaTx]);
  }

  private pageTx(pageNo: number, info: UploadedPage, version: number) {
    return tx.pages[id()]
      .update({ pageKey: info.pageKey, pageNo, version })
      .link({ owner: this.cfg.ownerId, pointerFile: info.fileId });
  }

  // uploadFile() only creates the $files row -- it never links `owner`
  // (there's nothing to link to yet at upload time), so that link has to be
  // set explicitly here, same as pages.owner above.
  private fileTx(info: UploadedPage) {
    return tx.$files[info.fileId].link({ owner: this.cfg.ownerId });
  }
}

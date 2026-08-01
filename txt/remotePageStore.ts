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
  authId: string; // $users id -- path prefix / pageKey identity
  r2Prefix: string;
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

  private async uploadPages(
    dirtyPages: Map<number, Buffer>,
    version: number,
  ): Promise<Map<number, UploadedPage>> {
    const uploaded = new Map<number, UploadedPage>();
    for (const [pageNo, body] of dirtyPages) {
      uploaded.set(pageNo, await this.uploadOnePage(pageNo, body, version));
    }
    return uploaded;
  }

  private async uploadOnePage(
    pageNo: number,
    body: Buffer,
    version: number,
  ): Promise<UploadedPage> {
    const pageKey = `${this.cfg.authId}:${pageNo}:${version}`;
    const rawPath = generateRawPath(this.cfg.r2Prefix);
    await this.cfg.r2.putObject(rawPath, body);
    const content = encodePagePointerContent(
      this.cfg.crypto,
      this.cfg.pathKey,
      rawPath,
    );
    const { data } = await this.cfg.db.storage.uploadFile(pageKey, content);
    return { fileId: data.id, pageKey };
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
    const dbMetaTx = tx.dbMeta[dbMetaId]
      .update({
        currentVersion: newVersion,
        pageCount,
        pageSize,
        needsGc: false,
      })
      .link({ owner: this.cfg.ownerId }); // idempotent if already linked
    await this.cfg.db.transact([...pageTxs, dbMetaTx]);
  }

  private pageTx(pageNo: number, info: UploadedPage, version: number) {
    return tx.pages[id()]
      .update({ pageKey: info.pageKey, pageNo, version })
      .link({ owner: this.cfg.ownerId, pointerFile: info.fileId });
  }
}

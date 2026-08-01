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
  decodePagePath,
  encodePagePath,
  generateRawPath,
} from "./pagePointer.ts";
import type { R2Client } from "./r2.ts";

const UPLOAD_PLACEHOLDER = Buffer.from([0]);

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

export class RemotePageStore {
  private cfg: RemotePageStoreConfig;

  constructor(cfg: RemotePageStoreConfig) {
    this.cfg = cfg;
  }

  async fetchPage(pageNo: number, targetVersion: number): Promise<Buffer> {
    const path = await this.resolvePagePath(pageNo, targetVersion);
    const rawPath = decodePagePath(this.cfg.crypto, this.cfg.pathKey, path);
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
    return row.pointerFile[0].path;
  }

  // Uploads every dirty page as a new version (all sharing one new version
  // number, per the commit protocol) and CAS-bumps dbMeta in one transact.
  async commitPages(
    dirtyPages: Map<number, Buffer>,
    dbMetaId: string,
    currentVersion: number,
    pageCount: number,
  ): Promise<CommitResult> {
    const newVersion = currentVersion + 1;
    const fileIds = await this.uploadPages(dirtyPages);
    await this.transactPages(fileIds, newVersion, dbMetaId, pageCount);
    return { newVersion, pageCount };
  }

  private async uploadPages(
    dirtyPages: Map<number, Buffer>,
  ): Promise<Map<number, string>> {
    const fileIds = new Map<number, string>();
    for (const [pageNo, body] of dirtyPages) {
      fileIds.set(pageNo, await this.uploadOnePage(pageNo, body));
    }
    return fileIds;
  }

  private async uploadOnePage(pageNo: number, body: Buffer): Promise<string> {
    const rawPath = generateRawPath(this.cfg.r2Prefix);
    await this.cfg.r2.putObject(rawPath, body);
    const path = encodePagePath(
      this.cfg.crypto,
      this.cfg.pathKey,
      this.cfg.authId,
      rawPath,
    );
    const { data } = await this.cfg.db.storage.uploadFile(
      path,
      UPLOAD_PLACEHOLDER,
    );
    return data.id;
  }

  private async transactPages(
    fileIds: Map<number, string>,
    newVersion: number,
    dbMetaId: string,
    pageCount: number,
  ): Promise<void> {
    const pageTxs = [...fileIds].map(([pageNo, fileId]) =>
      this.pageTx(pageNo, fileId, newVersion),
    );
    const dbMetaTx = tx.dbMeta[dbMetaId].update({
      currentVersion: newVersion,
      pageCount,
    });
    await this.cfg.db.transact([...pageTxs, dbMetaTx]);
  }

  private pageTx(pageNo: number, fileId: string, version: number) {
    const pageKey = `${this.cfg.authId}:${pageNo}:${version}`;
    return tx.pages[id()]
      .update({ pageKey, pageNo, version })
      .link({ owner: this.cfg.ownerId, pointerFile: fileId });
  }
}

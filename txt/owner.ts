// Read-only port of txt/owner.py's TxtOwner: resolves the account identified
// by creds.username and its keys, down to the one account's known raw R2
// paths. DatabaseSync/CryptoEngine/Logger are all injected so this stays
// independently testable.
import type { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync } from "node:zlib";
import * as C from "./constants.ts";
import type { Creds } from "./creds.ts";
import type { CryptoEngine } from "./crypto.ts";
import type { Logger } from "./logger.ts";
import type { R2Client } from "./r2.ts";

export interface KnownPaths {
  known: Set<string>;
  txtCount: number;
  // The R2 raw_path txt_metadata.content points to, if any -- null if there's
  // no txt_metadata row, content is still NULL, or content is still the
  // legacy inline-JSON format (nothing to keep in either of those cases).
  metadataRawPath: string | null;
}

// One entry from the decoded txt_metadata JSON document -- {"<txt_id>": {
// "name": ..., "metadata": {...}}, ...} (docs/data_model.md as of commit
// 1ed39d433365c39a6973303c171c7bb5510d7e3e). `metadata` is only present when
// a `<name>.opf` sidecar existed at ingest time.
export interface TxtMetadataEntry {
  name: string;
  metadata?: unknown;
}

export class TxtOwner {
  private db: DatabaseSync;
  private crypto: CryptoEngine;
  private log: Logger;

  constructor(db: DatabaseSync, crypto: CryptoEngine, log: Logger) {
    this.db = db;
    this.crypto = crypto;
    this.log = log;
  }

  resolveUserId(creds: Creds): number {
    const label = JSON.stringify(creds.username);
    const hash = this.crypto.usernameHash(
      creds.usernameLookupKey,
      creds.username,
    );
    const row = this.db
      .prepare("SELECT id FROM users WHERE username_hash = ?")
      .get(hash) as { id: number } | undefined;
    if (!row) throw new Error(`no user found for username=${label}`);
    this.log.debug(`Resolved owner user_id=${row.id} for username=${label}`);
    return row.id;
  }

  resolveUmk(creds: Creds, userId: number): Buffer {
    const row = this.db
      .prepare("SELECT umk FROM umk_store WHERE user_id = ?")
      .get(userId) as { umk: Uint8Array } | undefined;
    if (!row) throw new Error(`no umk_store row for user_id=${userId}`);
    const umk = this.crypto.blobDecrypt(creds.userRootKey, row.umk, false);
    this.log.debug(`Unwrapped umk for user_id=${userId}`);
    return umk;
  }

  collectKnownRawPaths(userId: number, umk: Buffer): KnownPaths {
    const txtIds = this.listTxtIds(userId);
    const known = new Set<string>();
    txtIds.forEach((txtId, i) =>
      this.addTxtPaths(txtId, umk, known, i, txtIds.length),
    );
    const metadataRawPath = this.resolveTxtMetadataRawPath(userId, umk);
    this.logMetadataResolution(metadataRawPath);
    if (metadataRawPath !== null) known.add(metadataRawPath);
    return { known, txtCount: txtIds.length, metadataRawPath };
  }

  private logMetadataResolution(metadataRawPath: string | null): void {
    if (metadataRawPath !== null) {
      this.log.info(
        `txt_metadata.content: found, keeping its R2 object ${metadataRawPath}`,
      );
    } else {
      this.log.info(
        "txt_metadata.content: not present (no R2 object to keep for it)",
      );
    }
  }

  private addTxtPaths(
    txtId: number,
    umk: Buffer,
    known: Set<string>,
    i: number,
    total: number,
  ): void {
    const txtKey = this.resolveTxtKey(txtId, umk);
    const paths = this.listPartRawPaths(txtId, txtKey);
    paths.forEach((p) => known.add(p));
    this.log.debug(
      `txt_id=${txtId} (${i + 1}/${total}): ${paths.length} known part path(s)`,
    );
  }

  // Public: reused by --migrate to pick a random sample of this user's
  // documents (--clean-bucket only ever needs every txt_id, via
  // collectKnownRawPaths above).
  listTxtIds(userId: number): number[] {
    const rows = this.db
      .prepare("SELECT id FROM txt WHERE user_id = ?")
      .all(userId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  // Public: --migrate needs txt_key directly (to pass into fetchTxtParts),
  // not just the paths it protects.
  resolveTxtKey(txtId: number, umk: Buffer): Buffer {
    const row = this.db
      .prepare("SELECT txt_key FROM txt WHERE id = ?")
      .get(txtId) as { txt_key: Uint8Array } | undefined;
    if (!row) throw new Error(`no txt row for txt_id=${txtId}`);
    return this.crypto.blobDecrypt(umk, row.txt_key, false);
  }

  // Public: --migrate needs a cheap (no R2, no decrypt) part count up front
  // -- for its dry-run/confirm summaries, which shouldn't have to download
  // every document's content just to report how many parts it has.
  countParts(txtId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM txt_parts WHERE txt_id = ?")
      .get(txtId) as { n: number };
    return row.n;
  }

  // Downloads and decrypts every part's content for one document, in
  // part_num order -- unlike listPartRawPaths (paths only, no download),
  // this actually fetches each part's ciphertext from R2 and unwraps it.
  // Each returned Buffer is still brotli(raw text) exactly as ingest.py
  // originally wrote it; a caller that just wants to re-store it elsewhere
  // (this tool's --migrate) never needs to decompress it itself. Fetches
  // R2_BATCH_CONCURRENCY parts at a time rather than one at a time (slow for
  // a document with many parts) or all at once (risks exhausting
  // connections/rate limits) -- same bounded-parallelism pattern as
  // RemotePageStore's own R2 round-trips. Promise.all preserves each batch's
  // input order, so the result stays in part_num order despite completing
  // out of order.
  async fetchTxtParts(
    txtId: number,
    txtKey: Buffer,
    r2: R2Client,
  ): Promise<Buffer[]> {
    const rawPaths = this.listPartRawPaths(txtId, txtKey);
    const parts: Buffer[] = [];
    for (let i = 0; i < rawPaths.length; i += C.R2_BATCH_CONCURRENCY) {
      const batch = rawPaths.slice(i, i + C.R2_BATCH_CONCURRENCY);
      const decrypted = await Promise.all(
        batch.map(async (rawPath) => {
          const ciphertext = await r2.getObject(rawPath);
          return this.crypto.blobDecrypt(txtKey, ciphertext, false);
        }),
      );
      parts.push(...decrypted);
    }
    return parts;
  }

  // The full decoded txt_metadata JSON document for this user (name/metadata
  // per txt_id) -- unlike resolveTxtMetadataRawPath below (which only cares
  // about which R2 object to preserve for --clean-bucket), this actually
  // downloads and decompresses it. null when there's nothing to decode: no
  // row, or content still NULL.
  async resolveTxtMetadataDocument(
    userId: number,
    umk: Buffer,
    r2: R2Client,
  ): Promise<Record<string, TxtMetadataEntry> | null> {
    const row = this.db
      .prepare(
        "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
      )
      .get(userId) as
      { txt_metadata_key: Uint8Array; content: Uint8Array | null } | undefined;
    if (!row || row.content === null) return null;
    const txtMetadataKey = this.crypto.blobDecrypt(
      umk,
      row.txt_metadata_key,
      false,
    );
    const jsonBytes = await this.decodeMetadataContent(
      row.content,
      txtMetadataKey,
      r2,
    );
    return JSON.parse(brotliDecompressSync(jsonBytes).toString("utf8"));
  }

  // Same legacy-vs-pointer byte-length distinction as
  // resolveTxtMetadataRawPath, but carried through to the actual JSON bytes
  // instead of stopping at the raw_path pointer.
  private async decodeMetadataContent(
    content: Uint8Array,
    txtMetadataKey: Buffer,
    r2: R2Client,
  ): Promise<Buffer> {
    if (content.length >= C.TXT_METADATA_LEGACY_THRESHOLD) {
      return this.crypto.blobDecrypt(txtMetadataKey, content, false);
    }
    const rawPath = this.crypto
      .blobDecrypt(txtMetadataKey, content, false)
      .toString("ascii");
    const objectBytes = await r2.getObject(rawPath);
    return this.crypto.blobDecrypt(txtMetadataKey, objectBytes, false);
  }

  private listPartRawPaths(txtId: number, txtKey: Buffer): string[] {
    const rows = this.db
      .prepare(
        "SELECT path FROM txt_parts WHERE txt_id = ? ORDER BY part_num ASC",
      )
      .all(txtId) as { path: Uint8Array }[];
    return rows.map((r) =>
      this.crypto.blobDecrypt(txtKey, r.path, false).toString("ascii"),
    );
  }

  // null when there's nothing to keep: no row, content still NULL, or
  // content is still the pre-R2-indirection legacy inline-JSON format
  // (>= TXT_METADATA_LEGACY_THRESHOLD bytes -- see docs/data_model.md).
  private resolveTxtMetadataRawPath(
    userId: number,
    umk: Buffer,
  ): string | null {
    const row = this.db
      .prepare(
        "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
      )
      .get(userId) as
      { txt_metadata_key: Uint8Array; content: Uint8Array | null } | undefined;
    if (
      !row ||
      row.content === null ||
      row.content.length >= C.TXT_METADATA_LEGACY_THRESHOLD
    ) {
      return null;
    }
    const txtMetadataKey = this.crypto.blobDecrypt(
      umk,
      row.txt_metadata_key,
      false,
    );
    return this.crypto
      .blobDecrypt(txtMetadataKey, row.content, false)
      .toString("ascii");
  }
}

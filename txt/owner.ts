// Read-only port of txt/owner.py's TxtOwner: resolves the account identified
// by creds.username and its keys, down to the one account's known raw R2
// paths. DatabaseSync/CryptoEngine/Logger are all injected so this stays
// independently testable.
import type { DatabaseSync } from "node:sqlite";
import * as C from "./constants.ts";
import type { Creds } from "./creds.ts";
import type { CryptoEngine } from "./crypto.ts";
import type { Logger } from "./logger.ts";

export interface KnownPaths {
  known: Set<string>;
  txtCount: number;
  // The R2 raw_path txt_metadata.content points to, if any -- null if there's
  // no txt_metadata row, content is still NULL, or content is still the
  // legacy inline-JSON format (nothing to keep in either of those cases).
  metadataRawPath: string | null;
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
    const umk = this.crypto.blobDecrypt(creds.userRootKey, row.umk);
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

  private listTxtIds(userId: number): number[] {
    const rows = this.db
      .prepare("SELECT id FROM txt WHERE user_id = ?")
      .all(userId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  private resolveTxtKey(txtId: number, umk: Buffer): Buffer {
    const row = this.db
      .prepare("SELECT txt_key FROM txt WHERE id = ?")
      .get(txtId) as { txt_key: Uint8Array } | undefined;
    if (!row) throw new Error(`no txt row for txt_id=${txtId}`);
    return this.crypto.blobDecrypt(umk, row.txt_key);
  }

  private listPartRawPaths(txtId: number, txtKey: Buffer): string[] {
    const rows = this.db
      .prepare(
        "SELECT path FROM txt_parts WHERE txt_id = ? ORDER BY part_num ASC",
      )
      .all(txtId) as { path: Uint8Array }[];
    return rows.map((r) =>
      this.crypto.blobDecrypt(txtKey, r.path).toString("ascii"),
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
    const txtMetadataKey = this.crypto.blobDecrypt(umk, row.txt_metadata_key);
    return this.crypto
      .blobDecrypt(txtMetadataKey, row.content)
      .toString("ascii");
  }
}

// Read-only access to the old shared-vault schema (docs/data_model.md @
// 1ed39d433365c39a6973303c171c7bb5510d7e3e): column-level encrypted blobs,
// keyed off a user_root_key -> umk -> txt_key chain, content pointed to by
// R2/S3 paths. Ignores users/txt_access/bookmarks/txt_shares/key_store
// entirely -- never read, not just excluded from the migrated output.

import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { SqliteDb } from "./sqlite.ts";
import type { BlobCipher } from "./blobCipher.ts";
import type { R2Client } from "./r2.ts";

const LEGACY_INLINE_THRESHOLD = 200;

export interface OldTxtRow {
  txtId: bigint;
  userId: bigint;
  txtKeyBlob: Buffer;
}

export interface OldPartRow {
  partNum: bigint;
  pathBlob: Buffer;
}

export type TxtMetadataMap = Record<string, { name: string; metadata?: unknown }>;

export class OldVault {
  private readonly db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.db = db;
  }

  static async open(hostPath: string): Promise<OldVault> {
    const preload = readFileSync(hostPath);
    const db = await SqliteDb.open("/old-vault.db", { preload, readOnly: true });
    return new OldVault(db);
  }

  /** Tries every umk_store row against rootKey; keeps only the ones that decrypt. */
  findDecryptableUmks(cipher: BlobCipher, rootKey: Uint8Array): Map<bigint, Buffer> {
    const result = new Map<bigint, Buffer>();
    const stmt = this.db.prepare("SELECT user_id, umk FROM umk_store;");
    while (stmt.step()) {
      try {
        result.set(stmt.columnInt64(0), cipher.decrypt(rootKey, stmt.columnBlob(1)));
      } catch {
        // Wrong root key for this user_id -- not one we can migrate.
      }
    }
    stmt.finalize();
    return result;
  }

  listTxt(ownerUserIds: Set<bigint>): OldTxtRow[] {
    const rows: OldTxtRow[] = [];
    const stmt = this.db.prepare("SELECT id, user_id, txt_key FROM txt;");
    while (stmt.step()) {
      const userId = stmt.columnInt64(1);
      if (ownerUserIds.has(userId))
        rows.push({ txtId: stmt.columnInt64(0), userId, txtKeyBlob: stmt.columnBlob(2) });
    }
    stmt.finalize();
    return rows;
  }

  listParts(txtId: bigint): OldPartRow[] {
    const rows: OldPartRow[] = [];
    const stmt = this.db.prepare(
      "SELECT part_num, path FROM txt_parts WHERE txt_id = ? ORDER BY part_num;",
    );
    stmt.bindInt64(1, txtId);
    while (stmt.step()) rows.push({ partNum: stmt.columnInt64(0), pathBlob: stmt.columnBlob(1) });
    stmt.finalize();
    return rows;
  }

  /** Raw (still-wrapped) txt_metadata_key/content for a user, or null if it has none yet. */
  metadataRaw(userId: bigint): { keyBlob: Buffer; content: Buffer } | null {
    const stmt = this.db.prepare(
      "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?;",
    );
    stmt.bindInt64(1, userId);
    if (!stmt.step()) {
      stmt.finalize();
      return null;
    }
    const result = { keyBlob: stmt.columnBlob(0), content: stmt.columnBlob(1) };
    stmt.finalize();
    return result;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Resolves a decrypted txt_metadata_key/content pair down to its {txt_id:
 * {name, metadata}} map, handling both content shapes: a small wrapped
 * pointer to an R2 object (the common case), or -- for accounts never
 * migrated off the old inline format -- the JSON directly.
 */
export async function resolveTxtMetadataMap(
  cipher: BlobCipher,
  r2: R2Client,
  metadataKey: Buffer,
  content: Buffer,
): Promise<TxtMetadataMap> {
  const isWrappedPath = content.length < LEGACY_INLINE_THRESHOLD;
  const encryptedJson = isWrappedPath
    ? await r2.get(cipher.decrypt(metadataKey, content).toString("ascii"))
    : content;
  const json = brotliDecompressSync(cipher.decrypt(metadataKey, encryptedJson));
  return JSON.parse(json.toString("utf8"));
}

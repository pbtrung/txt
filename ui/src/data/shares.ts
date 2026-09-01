import { encrypt } from "../crypto/cryptoBlob";
import type { VaultSession } from "../state/VaultContext";
import { toBase32Crockford } from "../util/base32Crockford";
import { toBase64 } from "../util/base64";
import { decodeCatalog } from "./catalog";
import type { DatabaseMutation } from "./databaseStore";
import { loadReaderDocument } from "./readerDocument";
import type { SqliteDatabase } from "./sqlite";

export interface BookShare {
  id: number;
  txtId: number;
  title: string;
  shareId: Uint8Array;
  contentKey: Uint8Array;
  prefix: Uint8Array;
  path: Uint8Array;
  state: "creating" | "active" | "deleting";
  createdAt: number;
}

export type ShareProgress = (step: string) => void;

export async function loadShares(db: SqliteDatabase): Promise<BookShare[]> {
  const rows = db.query(
    "SELECT s.id, s.txt_id, t.catalog, s.share_id, s.share_content_key, " +
      "s.share_prefix, s.share_path, s.state, s.created_at " +
      "FROM txt_shares s JOIN txt t ON t.id = s.txt_id ORDER BY s.id DESC",
  );
  return Promise.all(rows.map(toShare));
}

async function toShare(row: unknown[]): Promise<BookShare> {
  const catalog = await decodeCatalog(row[2] as Uint8Array);
  return {
    id: row[0] as number,
    txtId: row[1] as number,
    title: catalog.title,
    shareId: row[3] as Uint8Array,
    contentKey: row[4] as Uint8Array,
    prefix: row[5] as Uint8Array,
    path: row[6] as Uint8Array,
    state: row[7] as BookShare["state"],
    createdAt: row[8] as number,
  };
}

export async function createBookShare(
  session: VaultSession,
  txtId: number,
  onProgress?: ShareProgress,
): Promise<void> {
  onProgress?.("Loading book");
  const document = await session.database.read((db) =>
    loadReaderDocument(db, session.storage, session.dbPrefix, txtId),
  );
  if (!document) throw new Error("book content is missing");
  const material = newShareMaterial();
  onProgress?.("Saving share details");
  await session.database.mutate(insertShare(txtId, material));
  onProgress?.("Encrypting shared copy");
  const encrypted = await encrypt(document.epubBytes, material.contentKey);
  onProgress?.("Uploading shared copy");
  await session.storage.putShared(objectKey(session.dbPrefix, material), encrypted);
  onProgress?.("Registering share");
  await session.storage.registerShare(
    toBase32Crockford(material.prefix),
    toBase32Crockford(material.path),
    base64Url(material.shareId),
  );
  onProgress?.("Finishing share");
  await session.database.mutate(setShareState(material.shareId, "active"));
}

export async function deleteBookShare(
  session: VaultSession,
  share: BookShare,
  onProgress?: ShareProgress,
): Promise<void> {
  onProgress?.("Marking share for deletion");
  await session.database.mutate(setShareState(share.shareId, "deleting"));
  onProgress?.("Deleting shared copy");
  await session.storage.deleteShareRegistration(
    toBase32Crockford(share.prefix),
    toBase32Crockford(share.path),
    base64Url(share.shareId),
  );
  onProgress?.("Removing share details");
  await session.database.mutate(deleteShare(share.shareId));
}

export async function shareUrl(
  session: VaultSession,
  share: BookShare,
): Promise<string> {
  const grant = await session.storage.registerShare(
    toBase32Crockford(share.prefix),
    toBase32Crockford(share.path),
    base64Url(share.shareId),
  );
  const url = new URL("/shared", window.location.origin);
  url.hash = new URLSearchParams({
    id: base64Url(share.shareId),
    key: base64Url(share.contentKey),
    api: session.storage.apiBaseUrl(),
    grant,
  }).toString();
  return url.toString();
}

interface ShareMaterial {
  shareId: Uint8Array;
  contentKey: Uint8Array;
  prefix: Uint8Array;
  path: Uint8Array;
}

function newShareMaterial(): ShareMaterial {
  return {
    shareId: crypto.getRandomValues(new Uint8Array(32)),
    contentKey: crypto.getRandomValues(new Uint8Array(128)),
    prefix: crypto.getRandomValues(new Uint8Array(32)),
    path: crypto.getRandomValues(new Uint8Array(32)),
  };
}

function insertShare(txtId: number, value: ShareMaterial): DatabaseMutation {
  return {
    description: "create share",
    apply: (db) =>
      // OR IGNORE makes this replay-safe: a lost-then-retried R2 write can
      // resend the same insertShare mutation against a database that
      // already has this exact share_id from the write that actually
      // landed (docs/data_model.md §2 UNIQUE(share_id)).
      db.execute(
        "INSERT OR IGNORE INTO txt_shares " +
          "(txt_id, share_id, share_content_key, share_prefix, share_path, state, created_at) " +
          "VALUES (?, ?, ?, ?, ?, 'creating', ?)",
        [txtId, value.shareId, value.contentKey, value.prefix, value.path, Date.now()],
      ),
  };
}

function setShareState(
  shareId: Uint8Array,
  state: BookShare["state"],
): DatabaseMutation {
  return {
    description: `${state} share`,
    apply: (db) =>
      db.execute("UPDATE txt_shares SET state = ? WHERE share_id = ?", [
        state,
        shareId,
      ]),
  };
}

function deleteShare(shareId: Uint8Array): DatabaseMutation {
  return {
    description: "delete share",
    apply: (db) => db.execute("DELETE FROM txt_shares WHERE share_id = ?", [shareId]),
  };
}

function objectKey(
  dbPrefix: string,
  value: Pick<BookShare, "prefix" | "path">,
): string {
  return `${dbPrefix}/shared/${toBase32Crockford(value.prefix)}/${toBase32Crockford(value.path)}`;
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

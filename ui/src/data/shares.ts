// docs/sharing.md §4/§5: the owner creates and revokes shares entirely
// through /v1/shares -- D1 is the only durable state, so there is no
// local "creating"/"deleting" bookkeeping to keep in sync; a share is
// either registered on the server or it isn't.
import { decrypt, decryptJson, encrypt, encryptJson } from "../crypto/cryptoBlob";
import type { ApiClient, ShareRow } from "./apiClient";
import type { LibraryBook, LibraryStore } from "./libraryStore";
import { loadReaderDocument } from "./readerDocument";
import type { R2Session } from "./r2Session";
import { toBase32Crockford } from "../util/base32Crockford";
import { fromBase64, toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";
import type { OwnerSigningIdentity } from "./ownerProof";

export interface BookShare {
  shareIdHash: string; // base64, stable UI identity and revocation lookup key
  txtId: number;
  title: string;
  shareId: Uint8Array; // 32 bytes
  contentKey: Uint8Array; // share_content_key, 128 bytes
  sharePath: string; // base32-crockford, 52 characters
  state: "creating" | "active" | "deleting";
  createdAt: number;
}

export type ShareProgress = (step: string) => void;

export interface ShareSession {
  api: ApiClient;
  storage: R2Session;
  library: LibraryStore;
  signing: OwnerSigningIdentity;
  dbPrefix: string;
}

export async function loadShares(
  session: Pick<ShareSession, "api">,
  books: LibraryBook[],
  umk: Uint8Array,
): Promise<BookShare[]> {
  const rows = await session.api.fetchShares();
  const titleByDocument = new Map(books.map((book) => [book.txtId, book.title]));
  return Promise.all(rows.map((row) => toShare(row, titleByDocument, umk)));
}

async function toShare(
  row: ShareRow,
  titleByDocument: Map<number, string>,
  umk: Uint8Array,
): Promise<BookShare> {
  const rowKey = await decrypt(row.keyWrapped, umk);
  const payload = parseOwnerBlobPayload(
    await decryptJson<unknown>(row.ownerBlob, rowKey),
  );
  return {
    shareIdHash: toBase64(row.shareIdHash),
    txtId: row.documentId,
    title: titleByDocument.get(row.documentId) ?? "Book",
    shareId: payload.shareId,
    contentKey: payload.shareContentKey,
    sharePath: payload.sharePath,
    state: row.state,
    createdAt: row.createdAt,
  };
}

export async function createBookShare(
  session: ShareSession,
  umk: Uint8Array,
  txtId: number,
  onProgress?: ShareProgress,
): Promise<void> {
  onProgress?.("Loading book");
  const document = await loadReaderDocument(
    session.library,
    session.storage,
    session.dbPrefix,
    txtId,
  );
  if (!document) throw new Error("book content is missing");
  const material = newShareMaterial();

  onProgress?.("Encrypting shared copy");
  const encrypted = await encrypt(document.epubBytes, material.contentKey);
  onProgress?.("Uploading shared copy");
  await session.storage.putShared(
    objectKey(session.dbPrefix, material.sharePath),
    encrypted,
  );

  onProgress?.("Registering share");
  await registerShare(session, umk, txtId, material);
}

// Wraps a fresh key_store row key, encrypts owner_blob under it, and calls
// createShare() -- both createBookShare() (fresh material) and shareUrl()
// (re-registering existing material purely to obtain a new grant,
// docs/sharing.md §3.2) do exactly this sequence.
async function registerShare(
  session: ShareSession,
  umk: Uint8Array,
  txtId: number,
  material: ShareMaterial,
): Promise<string> {
  const rowKey = crypto.getRandomValues(new Uint8Array(128));
  const ownerBlob = await encryptJson(
    {
      share_id: base64Url(material.shareId),
      share_content_key: toBase64(material.contentKey),
      share_path: material.sharePath,
    },
    rowKey,
  );
  return session.api.createShare(
    {
      documentId: txtId,
      shareId: base64Url(material.shareId),
      sharePath: material.sharePath,
      keyWrapped: await encrypt(rowKey, umk),
      ownerBlob,
    },
    session.signing,
    session.dbPrefix,
  );
}

export async function deleteBookShare(
  session: ShareSession,
  share: BookShare,
  onProgress?: ShareProgress,
): Promise<void> {
  onProgress?.("Revoking share");
  await session.api.deleteShare(
    {
      documentId: share.txtId,
      shareId: base64Url(share.shareId),
      sharePath: share.sharePath,
    },
    session.signing,
    session.dbPrefix,
  );
}

export async function shareUrl(
  session: ShareSession,
  umk: Uint8Array,
  share: BookShare,
): Promise<string> {
  // Re-registering the same share_id/share_path is idempotent
  // (docs/sharing.md §3.2): the Worker recognizes the existing row by
  // share_id_hash and only re-mints a grant, leaving key_wrapped/owner_blob
  // untouched -- these are re-derived the same way createBookShare() built
  // them the first time purely so the request body is well-formed, not
  // because the server will store them again.
  const grant = await registerShare(session, umk, share.txtId, share);
  const url = new URL("/shared", window.location.origin);
  url.hash = new URLSearchParams({
    id: base64Url(share.shareId),
    key: base64Url(share.contentKey),
    grant,
  }).toString();
  return url.toString();
}

interface ShareMaterial {
  shareId: Uint8Array;
  contentKey: Uint8Array;
  sharePath: string;
}

function newShareMaterial(): ShareMaterial {
  return {
    shareId: crypto.getRandomValues(new Uint8Array(32)),
    contentKey: crypto.getRandomValues(new Uint8Array(128)),
    sharePath: toBase32Crockford(crypto.getRandomValues(new Uint8Array(32))),
  };
}

function objectKey(dbPrefix: string, sharePath: string): string {
  return `${dbPrefix}/shared/${sharePath}`;
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

interface OwnerBlobPayload {
  shareId: Uint8Array;
  shareContentKey: Uint8Array;
  sharePath: string;
}

function parseOwnerBlobPayload(value: unknown): OwnerBlobPayload {
  const data = objectRecord(value, "share owner blob");
  return {
    shareId: fromBase64Url(stringField(data, "share_id", "share owner blob")),
    shareContentKey: fromBase64(
      stringField(data, "share_content_key", "share owner blob"),
    ),
    sharePath: stringField(data, "share_path", "share owner blob"),
  };
}

function fromBase64Url(value: string): Uint8Array {
  return fromBase64(value.replaceAll("-", "+").replaceAll("_", "/"));
}

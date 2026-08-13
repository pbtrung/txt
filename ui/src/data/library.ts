// Loads this account's whole library: every txt row it owns
// (owner.id=authId) plus every sharedTxt row it owns -- its own copy of
// something shared to it (docs/data_model.md's Operating model: "only an
// admin account ever creates a txt row; a user account only ever reads
// documents shared to it," each as an independent, admin-made copy rather
// than a grant onto the admin's own rows). For each document, resolves its
// own root key (decrypt under this account's umk either way -- txt.txtKey
// for an owned doc, sharedTxt.userTxtKey for a share, no different
// mechanically) and decrypts its own metadata row's catalog into a
// BookInfo. Full metadata content is fetched only by the reader screen and
// metadata editor.
//
// Paginated the same way txt/bucket.ts's resolveOwnedDocuments pages
// through txt rows: an entity's own built-in `id` can't be used in an
// InstaQL `order` clause (confirmed against a real InstantDB app), so owned
// docs page by seq (set on every txt row by txt.ts --ingest) and shared
// docs page by sharedTxt's own unique shareKey -- a personal library can run
// to thousands of documents.

import * as blob from "../crypto/blob";
import { base64ToBytes } from "../crypto/bytes";
import { collectAllPages } from "./instaqlPagination";
import {
  parseMetadataCatalog,
  toCatalogBookInfo,
  type BookInfo,
} from "./metadata";

const PAGE_SIZE = 1500;

/** The only two fields of session.ts's own Session this module ever needs
 * -- narrower than importing that whole type, so a caller (e.g.
 * VaultContext.tsx's refresh(), which never re-derives r2Config/
 * txtAccess/txtBookmarks) doesn't have to fake the rest of it just to call
 * loadLibrary(). */
export interface LibrarySession {
  authId: string;
  umk: Uint8Array;
}

/** Which table a document's own row lives in -- reader.ts/tempR2Creds.ts
 * need this to query/authorize the right entity; the decrypt chain below
 * `docKey` is otherwise identical either way. */
export type LibraryDocKind = "txt" | "sharedTxt";

export interface LibraryDoc {
  /** This row's own id -- a txt row's for an owned doc, a sharedTxt row's
   * own id (never the source document's) for a share, since that's the row
   * this account actually reads through from here on. */
  txtId: string;
  kind: LibraryDocKind;
  info: BookInfo;
  /** This document's own unwrapped root key -- reused by reader.ts to open
   * it (decrypt prefix/txtPartKey/part content) without re-deriving it. */
  docKey: Uint8Array;
}

export interface LibrarySnapshot {
  metadataById: Map<string, BookInfo>;
  /** This account's own unwrapped root key for every document it can read --
   * reader.ts's only way to get one, since it never re-derives a docKey
   * itself. Keyed the same way as docKinds below (a sharedTxt row's own id
   * for a share, never the source document's). */
  docKeys: Map<string, Uint8Array>;
  /** Which table each docKeys entry's row actually lives in -- reader.ts/
   * tempR2Creds.ts need this to query/authorize the right entity; unrelated
   * callers that only ever touch an owned document (adminShares.ts,
   * adminBooks.ts) have no reason to consult this map at all. */
  docKinds: Map<string, LibraryDocKind>;
}

interface TxtMetadataLink {
  catalog?: string | null;
}

interface OwnedTxtRow {
  id: string;
  txtKey: string;
  txtMetadata: TxtMetadataLink[];
}

interface SharedTxtRow {
  id: string;
  userTxtKey: string;
  sharedTxtMetadata: TxtMetadataLink[];
}

async function toLibraryDoc(
  id: string,
  kind: LibraryDocKind,
  docKey: Uint8Array,
  metadataRow: TxtMetadataLink | undefined,
): Promise<LibraryDoc | null> {
  // Every txt/sharedTxt row has exactly one linked metadata row (has: "one"
  // on both sides, docs/data_model.md) -- absence here would mean a write
  // path bug elsewhere, not something this loader can recover from for this
  // one document. Skip it (log via the caller's own catch, if any) rather
  // than failing the whole library load over one bad row.
  if (!metadataRow?.catalog) return null;
  const catalog = await parseMetadataCatalog(docKey, metadataRow.catalog);
  return { txtId: id, kind, info: toCatalogBookInfo(id, catalog), docKey };
}

async function loadOwnedDocs(
  db: any,
  session: LibrarySession,
): Promise<LibraryDoc[]> {
  const rows = await collectAllPages<OwnedTxtRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      txt: {
        $: {
          where: { "owner.id": session.authId },
          order: { seq: "asc" },
          limit: PAGE_SIZE,
          offset,
          fields: ["txtKey"],
        },
        txtMetadata: { $: { fields: ["catalog"] } },
      },
    });
    const page = result.data.txt ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  const docs: LibraryDoc[] = [];
  for (const row of rows) {
    const docKey = await blob.decrypt(session.umk, base64ToBytes(row.txtKey));
    const doc = await toLibraryDoc(row.id, "txt", docKey, row.txtMetadata?.[0]);
    if (doc) docs.push(doc);
  }
  return docs;
}

async function loadSharedDocs(
  db: any,
  session: LibrarySession,
): Promise<LibraryDoc[]> {
  const rows = await collectAllPages<SharedTxtRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      sharedTxt: {
        $: {
          where: { "owner.id": session.authId },
          order: { shareKey: "asc" },
          limit: PAGE_SIZE,
          offset,
          fields: ["userTxtKey"],
        },
        sharedTxtMetadata: { $: { fields: ["catalog"] } },
      },
    });
    const page = result.data.sharedTxt ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  const docs: LibraryDoc[] = [];
  for (const row of rows) {
    const docKey = await blob.decrypt(
      session.umk,
      base64ToBytes(row.userTxtKey),
    );
    const doc = await toLibraryDoc(
      row.id,
      "sharedTxt",
      docKey,
      row.sharedTxtMetadata?.[0],
    );
    if (doc) docs.push(doc);
  }
  return docs;
}

export async function loadLibrary(
  db: any,
  session: LibrarySession,
): Promise<LibrarySnapshot> {
  const [owned, shared] = await Promise.all([
    loadOwnedDocs(db, session),
    loadSharedDocs(db, session),
  ]);

  const metadataById = new Map<string, BookInfo>();
  const docKeys = new Map<string, Uint8Array>();
  const docKinds = new Map<string, LibraryDocKind>();
  for (const doc of [...owned, ...shared]) {
    metadataById.set(doc.txtId, doc.info);
    docKeys.set(doc.txtId, doc.docKey);
    docKinds.set(doc.txtId, doc.kind);
  }
  return { metadataById, docKeys, docKinds };
}

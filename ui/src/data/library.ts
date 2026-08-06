// Loads this account's whole library: every txt row it owns
// (owner.id=authId) plus every txt shared to it (via a txtShares row where
// toUser.id=authId) -- docs/data_model.md's Operating model ("only an admin
// account ever creates a txt row; a user account only ever reads shared
// documents"). For each document, resolves its own txtKey (decrypt under
// this account's umk for an owned doc; Decapsulate via keyStore.privKey for
// a shared one -- docs/protocols.md's Sharing protocol) and decrypts its
// txtMetadata.catalog into a BookInfo. Full txtMetadata.content is fetched
// only by the reader screen and metadata editor.
//
// Paginated the same way txt/migrate.ts's resolveExistingTargets and
// txt/collectGarbage.ts's resolveSweepTargets page through txt rows: an
// entity's own built-in `id` can't be used in an InstaQL `order` clause
// (confirmed against a real InstantDB app), so owned docs page by
// sourceTxtId (set on every txt row today -- only --migrate ever creates
// one) and shared docs page by txtShares' own unique shareKey -- a personal
// library can run to thousands of documents.

import * as blob from "../crypto/blob";
import { base64ToBytes } from "../crypto/bytes";
import { collectAllPages } from "./instaqlPagination";
import { kemDecapsulate } from "./leancrypto";
import {
  parseMetadataCatalog,
  toCatalogBookInfo,
  type BookInfo,
} from "./metadata";

const PAGE_SIZE = 1500;

/** The only three fields of session.ts's own Session this module ever
 * needs -- narrower than importing that whole type, so a caller (e.g.
 * VaultContext.tsx's refresh(), which never re-derives r2Config/
 * txtAccess/txtBookmarks) doesn't have to fake the rest of it just to call
 * loadLibrary(). */
export interface LibrarySession {
  authId: string;
  umk: Uint8Array;
  keyStorePrivKey: Uint8Array;
}

export interface LibraryDoc {
  txtId: string;
  info: BookInfo;
  /** This document's own unwrapped txtKey -- reused by reader.ts to open
   * it (decrypt prefix/txtPartKey/part content) without re-deriving it. */
  docKey: Uint8Array;
}

export interface LibrarySnapshot {
  metadataById: Map<string, BookInfo>;
  /** This account's own unwrapped txtKey for every document it can read --
   * reader.ts's only way to get one, since it never re-derives a docKey
   * itself (owned vs. shared resolve completely differently -- see above). */
  docKeys: Map<string, Uint8Array>;
}

interface TxtMetadataLink {
  catalog?: string | null;
}

interface OwnedTxtRow {
  id: string;
  txtKey: string;
  txtMetadata: TxtMetadataLink[];
}

interface SharedTxtSharesRow {
  kemCt: string;
  txtKey: string;
  txt: { id: string; txtMetadata: TxtMetadataLink[] }[];
}

async function toLibraryDoc(
  txtId: string,
  docKey: Uint8Array,
  metadataRow: TxtMetadataLink | undefined,
): Promise<LibraryDoc | null> {
  // Every txt row has exactly one linked txtMetadata row (has: "one" on both
  // sides, docs/data_model.md) -- absence here would mean a write path bug
  // elsewhere, not something this loader can recover from for this one
  // document. Skip it (log via the caller's own catch, if any) rather than
  // failing the whole library load over one bad row.
  if (!metadataRow?.catalog) return null;
  const catalog = await parseMetadataCatalog(docKey, metadataRow.catalog);
  return { txtId, info: toCatalogBookInfo(txtId, catalog), docKey };
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
          order: { sourceTxtId: "asc" },
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
    const doc = await toLibraryDoc(row.id, docKey, row.txtMetadata?.[0]);
    if (doc) docs.push(doc);
  }
  return docs;
}

async function loadSharedDocs(
  db: any,
  session: LibrarySession,
): Promise<LibraryDoc[]> {
  const rows = await collectAllPages<SharedTxtSharesRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      txtShares: {
        $: {
          where: { "toUser.id": session.authId },
          order: { shareKey: "asc" },
          limit: PAGE_SIZE,
          offset,
          fields: ["kemCt", "txtKey"],
        },
        txt: {
          $: { fields: [] },
          txtMetadata: { $: { fields: ["catalog"] } },
        },
      },
    });
    const page = result.data.txtShares ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  const docs: LibraryDoc[] = [];
  for (const row of rows) {
    const txtRow = row.txt?.[0];
    if (!txtRow) continue; // the shared txt row itself is gone/inaccessible
    const ct = base64ToBytes(row.kemCt);
    const ss = await kemDecapsulate(session.keyStorePrivKey, ct);
    const docKey = await blob.decrypt(ss, base64ToBytes(row.txtKey));
    const doc = await toLibraryDoc(txtRow.id, docKey, txtRow.txtMetadata?.[0]);
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
  for (const doc of [...owned, ...shared]) {
    metadataById.set(doc.txtId, doc.info);
    docKeys.set(doc.txtId, doc.docKey);
  }
  return { metadataById, docKeys };
}

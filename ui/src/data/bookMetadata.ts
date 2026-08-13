import type { LibraryDocKind } from "./library";
import { parseMetadataContent, toBookInfo, type BookInfo } from "./metadata";

export class BookMetadataError extends Error {}

interface TxtMetadataContentRow {
  content: string;
}

const METADATA_LINK: Record<LibraryDocKind, string> = {
  txt: "txtMetadata",
  sharedTxt: "sharedTxtMetadata",
};

async function queryMetadataContent(
  db: any,
  txtId: string,
  kind: LibraryDocKind,
): Promise<TxtMetadataContentRow> {
  const metadataLink = METADATA_LINK[kind];
  const result = await db.queryOnce({
    [kind]: {
      $: { where: { id: txtId }, fields: [] },
      [metadataLink]: { $: { fields: ["content"] } },
    },
  });
  const row = result.data[kind]?.[0]?.[metadataLink]?.[0];
  const content = row?.content;
  if (!content) {
    throw new BookMetadataError(
      `missing ${metadataLink}.content for ${kind} ${txtId}`,
    );
  }
  return { content };
}

export async function fetchBookInfo(
  db: any,
  txtId: string,
  kind: LibraryDocKind,
  docKey: Uint8Array,
): Promise<BookInfo> {
  const row = await queryMetadataContent(db, txtId, kind);
  const content = await parseMetadataContent(docKey, row.content);
  return toBookInfo(txtId, content);
}

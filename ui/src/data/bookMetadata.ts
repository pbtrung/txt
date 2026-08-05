import { parseMetadataContent, toBookInfo, type BookInfo } from "./metadata";

export class BookMetadataError extends Error {}

interface TxtMetadataContentRow {
  content: string;
}

async function queryTxtMetadataContent(
  db: any,
  txtId: string,
): Promise<TxtMetadataContentRow> {
  const result = await db.queryOnce({
    txt: {
      $: { where: { id: txtId }, fields: [] },
      txtMetadata: { $: { fields: ["content"] } },
    },
  });
  const row = result.data.txt?.[0]?.txtMetadata?.[0];
  const content = row?.content;
  if (!content) {
    throw new BookMetadataError(`missing txtMetadata.content for txt ${txtId}`);
  }
  return { content };
}

export async function fetchBookInfo(
  db: any,
  txtId: string,
  docKey: Uint8Array,
): Promise<BookInfo> {
  const row = await queryTxtMetadataContent(db, txtId);
  const content = await parseMetadataContent(docKey, row.content);
  return toBookInfo(txtId, content);
}

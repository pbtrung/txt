import { tx } from "@instantdb/react";

import {
  catalogFromMetadataContent,
  parseMetadataContent,
  toBookInfo,
  wrapMetadataCatalog,
  wrapMetadataContent,
  type BookInfo,
  type OpfMetadata,
  type OpfValue,
  type TxtMetadataContent,
} from "./metadata";

export class AdminBooksError extends Error {}

export interface AdminBooksSession {
  docKeys: Map<string, Uint8Array>;
}

export interface BookMetadataEdits {
  title?: string;
  author?: string;
  publisher?: string;
  subjects: string[];
  description?: string;
}

interface TxtMetadataRow {
  id: string;
  content: string;
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function withTextValue(current: OpfValue | undefined, value: string): OpfValue {
  if (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current)
  ) {
    return { ...current, text: value };
  }
  return value;
}

function setTextField(
  metadata: OpfMetadata,
  key: string,
  value: string | undefined,
) {
  const next = trimmed(value);
  if (!next) {
    delete metadata[key];
    return;
  }
  metadata[key] = withTextValue(metadata[key], next);
}

export function applyBookMetadataEdits(
  content: TxtMetadataContent,
  edits: BookMetadataEdits,
): TxtMetadataContent {
  const metadata: OpfMetadata = { ...content.metadata };
  setTextField(metadata, "title", edits.title);
  setTextField(metadata, "creator", edits.author);
  setTextField(metadata, "publisher", edits.publisher);
  setTextField(metadata, "description", edits.description);

  const subjects = edits.subjects.map((s) => s.trim()).filter(Boolean);
  if (subjects.length === 0) {
    delete metadata.subject;
  } else {
    metadata.subject = subjects.length === 1 ? subjects[0]! : subjects;
  }

  return { ...content, metadata };
}

async function queryTxtMetadata(
  db: any,
  txtId: string,
): Promise<TxtMetadataRow> {
  const result = await db.queryOnce({
    txt: {
      $: { where: { id: txtId }, fields: [] },
      txtMetadata: { $: { fields: ["content"] } },
    },
  });
  const row = result.data.txt?.[0]?.txtMetadata?.[0];
  if (!row?.id || !row.content) {
    throw new AdminBooksError(`missing txtMetadata row for txt ${txtId}`);
  }
  return row;
}

export async function saveBookMetadata(
  db: any,
  session: AdminBooksSession,
  txtId: string,
  edits: BookMetadataEdits,
  onProgress?: (label: string) => void,
): Promise<BookInfo> {
  const docKey = session.docKeys.get(txtId);
  if (!docKey) {
    throw new AdminBooksError(`missing document key for txt ${txtId}`);
  }

  onProgress?.("Loading metadata");
  const row = await queryTxtMetadata(db, txtId);
  const current = await parseMetadataContent(docKey, row.content);
  const next = applyBookMetadataEdits(current, edits);

  onProgress?.("Saving metadata");
  const content = await wrapMetadataContent(docKey, next);
  const catalog = await wrapMetadataCatalog(
    docKey,
    catalogFromMetadataContent(next),
  );
  await db.transact([tx.txtMetadata![row.id]!.update({ content, catalog })]);

  return toBookInfo(txtId, next);
}

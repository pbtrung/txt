// Reads the txt table's brotli(JSON) metadata blobs (docs/data_model.md
// §3.1: {name, metadata: {...opf fields}}) into plain LibraryBook records
// for the Library screen's search/browse-by-author/subject/publisher.
// opf fields (txt/opf.py's own output) don't have a fixed schema: a dc:*
// element becomes a plain string, or {text, ...attrs} once it carries
// attributes (scheme/id/role/file-as), and a repeated tag collapses into
// an array -- fieldStrings() normalizes all three shapes into string[].
import { brotliDecompress } from "../crypto/brotli";
import type { SqliteDatabase } from "./sqlite";

export interface LibraryBook {
  txtId: number;
  title: string;
  sortKey: string | null;
  authors: string[];
  subjects: string[];
  publisher: string | null;
}

type OpfField = string | { text: string; [attr: string]: string };

interface OpfSidecar {
  name: string;
  metadata: Record<string, OpfField | OpfField[]>;
}

function fieldText(field: OpfField): string {
  return typeof field === "string" ? field : field.text;
}

function fieldStrings(field: OpfField | OpfField[] | undefined): string[] {
  if (field === undefined) return [];
  return (Array.isArray(field) ? field : [field]).map(fieldText);
}

async function toBook(txtId: number, metadataBlob: Uint8Array): Promise<LibraryBook> {
  const json = new TextDecoder().decode(await brotliDecompress(metadataBlob));
  const sidecar = JSON.parse(json) as OpfSidecar;
  const opf = sidecar.metadata ?? {};
  const titles = fieldStrings(opf.title);
  return {
    txtId,
    title: titles[0] ?? sidecar.name,
    sortKey: null,
    authors: fieldStrings(opf.creator),
    subjects: fieldStrings(opf.subject),
    publisher: fieldStrings(opf.publisher)[0] ?? null,
  };
}

export async function loadLibraryBooks(db: SqliteDatabase): Promise<LibraryBook[]> {
  const rows = db.query("SELECT id, metadata FROM txt ORDER BY id");
  return Promise.all(
    rows.map(([id, metadata]) => toBook(id as number, metadata as Uint8Array)),
  );
}

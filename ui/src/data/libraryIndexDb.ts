// Reads doc/term/doc_term out of the decrypted library index (docs/data_model.md
// §8.1) into plain LibraryBook records. Recency/read-position isn't carried
// in this file at all -- data_model.md §8.2: "it changes on every page turn
// and comes from txt_access once BB is open" -- so the Library screen (which
// never opens BB) has no Recent/in-progress view; that's Reader's job.
import { openSqliteFromBytes, type SqlRow } from "./sqlite";

export interface LibraryBook {
  txtId: number;
  title: string;
  sortKey: string | null;
  authors: string[];
  subjects: string[];
  publisher: string | null;
}

const AUTHOR = 1;
const SUBJECT = 2;
const PUBLISHER = 3;

function rowsByDoc(rows: SqlRow[]): Map<number, string[]> {
  const byDoc = new Map<number, string[]>();
  for (const [docId, name] of rows as [number, string][]) {
    const names = byDoc.get(docId) ?? [];
    names.push(name);
    byDoc.set(docId, names);
  }
  return byDoc;
}

function termsOfKind(db: { query(sql: string): SqlRow[] }, kind: number): Map<number, string[]> {
  const rows = db.query(
    `SELECT doc_term.doc_id, term.name FROM doc_term JOIN term ON term.id = doc_term.term_id ` +
      `WHERE doc_term.kind = ${kind} ORDER BY doc_term.doc_id, doc_term.ord`,
  );
  return rowsByDoc(rows);
}

export async function loadLibraryBooks(bytes: Uint8Array): Promise<LibraryBook[]> {
  const db = await openSqliteFromBytes(bytes);
  try {
    const docs = db.query("SELECT txt_id, title, sort_key FROM doc") as [number, string, string | null][];
    const authors = termsOfKind(db, AUTHOR);
    const subjects = termsOfKind(db, SUBJECT);
    const publishers = termsOfKind(db, PUBLISHER);
    return docs.map(([txtId, title, sortKey]) => ({
      txtId,
      title,
      sortKey,
      authors: authors.get(txtId) ?? [],
      subjects: subjects.get(txtId) ?? [],
      publisher: publishers.get(txtId)?.[0] ?? null,
    }));
  } finally {
    db.close();
  }
}

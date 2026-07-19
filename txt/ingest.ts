import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { SqlCipherDb } from "./db.ts";
import { Metadata, type MetadataEntry } from "./metadata.ts";
import { preprocessText, splitParts } from "./textproc.ts";
import { PART_TARGET_BYTES } from "./constants.ts";

export interface IngestResult {
  files: number;
  parts: number;
}

function listTxtFiles(srcDir: string): string[] {
  return readdirSync(srcDir)
    .filter((name) => extname(name).toLowerCase() === ".txt")
    .sort();
}

function addFile(db: SqlCipherDb, srcDir: string, file: string, entries: MetadataEntry[]): number {
  const raw = readFileSync(join(srcDir, file));
  const chunks = splitParts(preprocessText(raw), PART_TARGET_BYTES);
  const txtId = db.insertTxt();
  chunks.forEach((chunk, i) => db.insertPart(txtId, i + 1, brotliCompressSync(chunk)));
  entries.push(Metadata.entry(txtId, file));
  return chunks.length;
}

export class Ingest {
  static run(db: SqlCipherDb, srcDir: string): IngestResult {
    const files = listTxtFiles(srcDir);
    const entries = Metadata.decode(db.getMetadataBlob());
    let parts = 0;
    for (const file of files) parts += addFile(db, srcDir, file, entries);
    db.setMetadataBlob(Metadata.encode(entries));
    return { files: files.length, parts };
  }
}

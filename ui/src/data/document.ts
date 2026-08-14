// Reads one document's txt/txt_meta/txt_parts rows out of an open BB
// (docs/data_model.md §7). txt.prefix and txt_parts.path are raw 32-byte
// R2 prefixes -- base32-Crockford is applied here, matching how every
// other such value in this system is rendered before use in an object key
// ("path is the raw 32 random bytes; base32-Crockford is applied to both
// txt.prefix and path when forming the object URL").
import { brotliDecompress } from "../crypto/brotli";
import { toBase32Crockford } from "../util/base32Crockford";
import type { BBEngine } from "./bbEngine";

export interface TxtPart {
  partNum: number;
  path: string;
}

export interface TxtDocument {
  id: number;
  txtKey: Uint8Array;
  prefix: string;
  name: string;
  nParts: number;
  metadata: Record<string, unknown> | null;
  parts: TxtPart[];
}

async function readMetadata(bb: BBEngine, txtId: number): Promise<Record<string, unknown> | null> {
  const rows = bb.query("SELECT metadata FROM txt_meta WHERE txt_id = ?", [txtId]);
  if (rows.length === 0) return null;
  const decompressed = await brotliDecompress(rows[0][0] as Uint8Array);
  return JSON.parse(new TextDecoder().decode(decompressed)) as Record<string, unknown>;
}

function readParts(bb: BBEngine, txtId: number): TxtPart[] {
  return bb
    .query("SELECT part_num, path FROM txt_parts WHERE txt_id = ? ORDER BY part_num", [txtId])
    .map(([partNum, path]) => ({ partNum: partNum as number, path: toBase32Crockford(path as Uint8Array) }));
}

export async function readDocument(bb: BBEngine, txtId: number): Promise<TxtDocument | null> {
  const rows = bb.query("SELECT id, txt_key, prefix, name, n_parts FROM txt WHERE id = ?", [txtId]);
  if (rows.length === 0) return null;
  const [id, txtKey, prefix, name, nParts] = rows[0];
  return {
    id: id as number,
    txtKey: txtKey as Uint8Array,
    prefix: toBase32Crockford(prefix as Uint8Array),
    name: name as string,
    nParts: nParts as number,
    metadata: await readMetadata(bb, txtId),
    parts: readParts(bb, txtId),
  };
}

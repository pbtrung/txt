import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

export interface MetadataEntry {
  [txtId: string]: { name: string };
}

export class Metadata {
  static decode(compressed: Uint8Array | null): MetadataEntry[] {
    if (!compressed) return [];
    const json = brotliDecompressSync(compressed).toString("utf8");
    return JSON.parse(json) as MetadataEntry[];
  }

  static encode(entries: MetadataEntry[]): Uint8Array {
    const json = JSON.stringify(entries);
    return brotliCompressSync(Buffer.from(json, "utf8"));
  }

  static entry(txtId: number, name: string): MetadataEntry {
    return { [String(txtId)]: { name } };
  }
}

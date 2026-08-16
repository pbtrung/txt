import { brotliDecompress } from "../crypto/brotli";
import { objectRecord, stringArrayField, stringField } from "../util/validation";

interface Catalog {
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
}

export async function decodeCatalog(blob: Uint8Array): Promise<Catalog> {
  const decompressed = await brotliDecompress(blob);
  const json = new TextDecoder().decode(decompressed);
  const data = objectRecord(JSON.parse(json), "catalog");
  const publisher = data.publisher;
  if (publisher !== undefined && publisher !== null && typeof publisher !== "string") {
    throw new Error("catalog has an invalid publisher");
  }
  return {
    title: stringField(data, "title", "catalog"),
    authors: stringArrayField(data, "authors", "catalog"),
    subjects: stringArrayField(data, "subjects", "catalog"),
    publisher: publisher ?? null,
  };
}

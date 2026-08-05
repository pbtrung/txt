import type { CryptoEngine } from "./crypto.ts";

export interface TxtMetadataContent {
  name: string;
  metadata?: unknown;
}

export interface TxtMetadataCatalog {
  name: string;
  title: string;
  authors: string[];
  subjects: string[];
  publishers: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// opf.py stores a metadata field as a string, a {text, ...attrs} object, or
// a list of either for repeated tags. Keep this extractor tolerant so a
// malformed sidecar affects only the malformed field, not the whole row.
function textOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return textOf(value[0]);
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return undefined;
}

function textsOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((v) => textOf(v)).filter((s): s is string => Boolean(s));
  }
  const single = textOf(value);
  return single ? [single] : [];
}

function parseMetadataContent(content: unknown): {
  name: string;
  metadata: Record<string, unknown>;
} {
  if (!isRecord(content)) {
    throw new Error("txtMetadata.content must decode to a JSON object");
  }
  if (typeof content.name !== "string") {
    throw new Error("txtMetadata.content missing string name");
  }
  return {
    name: content.name,
    metadata: isRecord(content.metadata) ? content.metadata : {},
  };
}

export function catalogFromMetadataContent(
  content: unknown,
): TxtMetadataCatalog {
  const { name, metadata } = parseMetadataContent(content);
  return {
    name,
    title: textOf(metadata.title) ?? name,
    authors: textsOf(metadata.creator),
    subjects: textsOf(metadata.subject),
    publishers: textsOf(metadata.publisher),
  };
}

export function wrapCatalogBlob(
  crypto: CryptoEngine,
  txtKey: Uint8Array,
  catalog: TxtMetadataCatalog,
): string {
  const plaintext = Buffer.from(JSON.stringify(catalog), "utf8");
  return crypto.blobEncrypt(txtKey, plaintext, true).toString("base64");
}

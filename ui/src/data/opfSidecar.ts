// Parses the txt table's brotli(JSON) metadata blobs (docs/data_model.md
// §3.1: {name, metadata: {...opf fields}}), shared by the Library and
// Reader screens' data layers. opf fields (txt/opf.py's own output) don't
// have a fixed schema: a dc:* element becomes a plain string, or
// {text, ...attrs} once it carries attributes (scheme/id/role/file-as),
// and a repeated tag collapses into an array -- fieldStrings() normalizes
// all three shapes into string[].
import { brotliDecompress } from "../crypto/brotli";

export type OpfField = string | { text: string; [attr: string]: string };

export interface OpfSidecar {
  name: string;
  metadata: Record<string, OpfField | OpfField[]>;
}

export function fieldText(field: OpfField): string {
  return typeof field === "string" ? field : field.text;
}

export function fieldStrings(field: OpfField | OpfField[] | undefined): string[] {
  if (field === undefined) return [];
  return (Array.isArray(field) ? field : [field]).map(fieldText);
}

export async function parseOpfSidecar(metadataBlob: Uint8Array): Promise<OpfSidecar> {
  const json = new TextDecoder().decode(await brotliDecompress(metadataBlob));
  return JSON.parse(json) as OpfSidecar;
}

export function titleOf(sidecar: OpfSidecar): string {
  return fieldStrings(sidecar.metadata?.title)[0] ?? sidecar.name;
}

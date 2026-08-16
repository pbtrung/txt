// Shared OPF metadata types and normalizers. An OPF field can be a string,
// an attributed value, or an array when a tag is repeated.
export type OpfField = string | { text: string; [attr: string]: string };

export interface ParsedOpf {
  metadata: Record<string, OpfField | OpfField[]>;
}

function fieldText(field: OpfField): string {
  return typeof field === "string" ? field : field.text;
}

export function fieldStrings(field: OpfField | OpfField[] | undefined): string[] {
  if (field === undefined) return [];
  return (Array.isArray(field) ? field : [field])
    .map((value) => fieldText(value).trim())
    .filter(Boolean);
}

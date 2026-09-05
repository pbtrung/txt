// docs/data_model.md §2.1: the singleton catalog pointer row. Read-only,
// Access session only (no proof) -- same posture as GET /v1/documents.
// No GET route of its own any more: this is one of the three queries
// libraryEndpoint.ts's GET /v1/library combines into a single request.
import { base64Encode } from "./base64";

export interface CatalogRow {
  key_wrapped: ArrayBuffer;
  catalog_blob: ArrayBuffer;
}

export const CATALOG_QUERY = `
  SELECT k.wrapped_key AS key_wrapped, c.catalog_blob
  FROM catalog c
  JOIN key_store k ON k.id = c.key_id
  WHERE c.singleton = 1
`;

export function catalogJson(row: CatalogRow) {
  return {
    key_wrapped: base64Encode(row.key_wrapped),
    catalog_blob: base64Encode(row.catalog_blob),
  };
}

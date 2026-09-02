// docs/data_model.md §2.1: the singleton catalog pointer row. Read-only,
// Access session only (no proof) -- same posture as GET /v1/documents.
import { base64Encode } from "./base64";

interface CatalogRow {
  key_wrapped: ArrayBuffer;
  catalog_blob: ArrayBuffer;
}

const CATALOG_QUERY = `
  SELECT k.wrapped_key AS key_wrapped, c.catalog_blob
  FROM catalog c
  JOIN key_store k ON k.id = c.key_id
  WHERE c.singleton = 1
`;

export async function handleGetCatalog(env: Env): Promise<Response> {
  const row = await env.DB.prepare(CATALOG_QUERY).first<CatalogRow>();
  if (!row) {
    return Response.json({ catalog: null });
  }
  return Response.json({
    catalog: {
      key_wrapped: base64Encode(row.key_wrapped),
      catalog_blob: base64Encode(row.catalog_blob),
    },
  });
}

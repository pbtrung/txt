// On-demand part fetch (docs/protocols.md's Read path): query txtParts (or,
// for a share, sharedTxtParts) for the target document (already includes
// txtPartKey/path), decrypt the row's own prefix directly under docKey,
// decrypt each part's own txtPartKey under that same docKey, then -- per
// part, on demand -- decrypt path under txtPartKey to recover raw_key, GET
// "${prefix}/${raw_key}" from R2, and decrypt the object body under that
// same txtPartKey. Two hops (one InstantDB query, one R2 fetch) either way
// -- only which table is queried (kind, from library.ts's docKinds) and how
// docKey itself was obtained differs, both already resolved by the caller.

import type { AwsClient } from "aws4fetch";

import * as blob from "../crypto/blob";
import { base64ToBytes } from "../crypto/bytes";
import type { LibraryDocKind } from "./library";
import { getObject } from "./r2";
import type { R2Config } from "./r2Config";
import { unwrapToken } from "./randomToken";

interface OpenedPart {
  partNum: number;
  txtPartKey: Uint8Array;
  path: string;
}

export interface OpenedDoc {
  txtId: string;
  kind: LibraryDocKind;
  docKey: Uint8Array;
  prefix: string;
  parts: OpenedPart[];
}

interface TxtPartRow {
  partNum: number;
  txtPartKey: string;
  path: string;
}

const PARTS_LINK: Record<LibraryDocKind, string> = {
  txt: "txtParts",
  sharedTxt: "sharedTxtParts",
};

/** Opens a document for reading: decrypts its own R2 prefix and every
 * part's own (still R2-address-wrapping) txtPartKey -- one query, not one
 * per part. Doesn't fetch any part's actual content yet (see partContent). */
export async function openDoc(
  db: any,
  txtId: string,
  kind: LibraryDocKind,
  docKey: Uint8Array,
): Promise<OpenedDoc> {
  const partsLink = PARTS_LINK[kind];
  const result = await db.queryOnce({
    [kind]: {
      $: { where: { id: txtId } },
      [partsLink]: {},
    },
  });
  const row = result.data[kind]?.[0];
  if (!row) throw new Error(`no ${kind} row for id=${txtId}`);

  const prefix = await unwrapToken(docKey, row.prefix);
  const rows = (row[partsLink] ?? []) as TxtPartRow[];
  const parts = await Promise.all(
    rows.map(async (row): Promise<OpenedPart> => {
      const txtPartKey = await blob.decrypt(
        docKey,
        base64ToBytes(row.txtPartKey),
      );
      return { partNum: row.partNum, txtPartKey, path: row.path };
    }),
  );
  parts.sort((a, b) => a.partNum - b.partNum);

  return { txtId, kind, docKey, prefix, parts };
}

export function partCount(doc: OpenedDoc): number {
  return doc.parts.length;
}

/** Fetches and decrypts one part's content: decrypt path -> raw_key, R2 GET
 * "${prefix}/${raw_key}", decrypt the object body -- both AEAD steps keyed
 * by that same part's own txtPartKey (docs/key_hierarchy.md). */
export async function partContent(
  doc: OpenedDoc,
  r2Client: AwsClient,
  r2Config: R2Config,
  partNum: number,
): Promise<string> {
  const part = doc.parts.find((p) => p.partNum === partNum);
  if (!part) {
    throw new Error(
      `no txtParts row for txtId=${doc.txtId}, partNum=${partNum}`,
    );
  }
  const rawKey = await unwrapToken(part.txtPartKey, part.path);
  const rawPath = `${doc.prefix}/${rawKey}`;
  const body = await getObject(r2Client, r2Config, rawPath);
  const plaintext = await blob.decrypt(part.txtPartKey, body, true);
  return new TextDecoder().decode(plaintext);
}

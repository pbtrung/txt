import { decrypt } from "../crypto/cryptoBlob";
import { fromBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";
import { extraMetadataFields, parseEpubOpf } from "./epubOpf";
import { withNetworkRetries } from "./networkRequest";
import { fieldStrings } from "./opfMetadata";
import type { ReaderDocument, ReaderLoadProgress } from "./readerDocument";

const SHARE_ID_BYTES = 32;
const CONTENT_KEY_BYTES = 128;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const SHARED_READER_LOAD_TOTAL_STEPS = 4;

const MAX_GRANT_LENGTH = 512;

export interface SharedReference {
  id: string;
  contentKey: Uint8Array;
  grant: string;
}

export function parseSharedReference(hash: string): SharedReference | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const id = params.get("id");
  const key = params.get("key");
  const grant = params.get("grant");
  if (
    !id ||
    !key ||
    !grant ||
    !BASE64URL.test(id) ||
    !BASE64URL.test(grant) ||
    grant.length > MAX_GRANT_LENGTH
  ) {
    return null;
  }
  try {
    const shareId = decodeBase64Url(id);
    const contentKey = decodeBase64Url(key);
    return shareId.byteLength === SHARE_ID_BYTES &&
      contentKey.byteLength === CONTENT_KEY_BYTES
      ? { id, contentKey, grant }
      : null;
  } catch {
    return null;
  }
}

export async function loadSharedReaderDocument(
  reference: SharedReference,
  onProgress?: (progress: ReaderLoadProgress) => void,
): Promise<ReaderDocument> {
  report(onProgress, "Requesting shared book", 1);
  const encrypted = await withNetworkRetries(async (signal) => {
    const response = await fetch("/v1/shared-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ share_id: reference.id, grant: reference.grant }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 404) throw new Error("This shared book is unavailable.");
      throw new Error(`Could not download this shared book (${response.status}).`);
    }
    const url = sharedObjectUrl(await response.json());
    report(onProgress, "Downloading shared book", 2);
    const object = await fetch(url, { signal });
    if (!object.ok) throw new Error(`Could not download this shared book.`);
    return new Uint8Array(await object.arrayBuffer());
  });
  report(onProgress, "Decrypting shared book", 3);
  const epubBytes = await decrypt(encrypted, reference.contentKey);
  report(onProgress, "Reading book metadata", 4);
  const opf = await parseEpubOpf(epubBytes);
  const titles = fieldStrings(opf.metadata.title);
  const publishers = fieldStrings(opf.metadata.publisher);
  return {
    txtId: 0,
    lastCfi: null,
    title: titles[0] ?? "Shared book",
    authors: fieldStrings(opf.metadata.creator),
    subjects: fieldStrings(opf.metadata.subject),
    publisher: publishers[0] ?? null,
    extraMetadata: extraMetadataFields(opf),
    epubBytes,
  };
}

function sharedObjectUrl(value: unknown): string {
  const data = objectRecord(value, "shared URL response");
  const valueUrl = stringField(data, "url", "shared URL response");
  const url = new URL(valueUrl);
  if (url.protocol !== "https:") throw new Error("shared object URL must use HTTPS");
  return url.toString();
}

function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new Error("invalid base64url");
  return fromBase64(value.replaceAll("-", "+").replaceAll("_", "/"));
}

function report(
  callback: ((progress: ReaderLoadProgress) => void) | undefined,
  label: string,
  step: number,
): void {
  callback?.({ label, step, total: SHARED_READER_LOAD_TOTAL_STEPS });
}

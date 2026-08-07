// Byte lengths and blob-format fields. See docs/crypto.md for the blob
// format these sizes back.

export const MAGIC = [0x54, 0x58];
export const VERSION_MAJOR = 0x01;
export const VERSION_MINOR = 0x00;

export const SALT_LEN = 64;
export const TAG_LEN = 64;
export const KEY_LEN = 64;
export const IV_LEN = 64;
export const OKM_LEN = KEY_LEN + IV_LEN; // 128
export const HEADER_LEN = 4; // magic(2) + version(2)
export const AD_LEN = HEADER_LEN + SALT_LEN; // 68
export const BLOB_MIN_LEN = AD_LEN + TAG_LEN; // 132

// docs/crypto.md's Blob format: structured (e.g. JSON) payloads are
// brotli-compressed before AEAD encryption, at the max quality level --
// matches ui/src/crypto/constants.ts's own BROTLI_QUALITY (brotli is a
// deterministic public format, RFC 7932, so both sides producing/reading
// each other's blobs need no version negotiation over the quality level).
export const BROTLI_QUALITY = 11;

export const USER_ROOT_KEY_MIN_LEN = 256;

// docs/key_hierarchy.md: every symmetric wrapping/content key in the current
// design (umk, keyStore.keyStoreKey, credStore.credStoreKey, txt.txtKey,
// txtParts.txtPartKey, txtAccess.txtAccessKey, txtBookmarks.txtBookmarkKey)
// is 128 random bytes -- one shared constant rather than a same-valued one
// per entity.
export const RANDOM_KEY_LEN = 128;

// docs/data_model.md's txt.prefix / txtParts.path: both are a
// Crockford-base32-lowercase encoding of this many random bytes.
export const RAW_TOKEN_LEN = 32;

// textproc.ts's splitParts groups paragraphs into txtParts-sized chunks up
// to roughly this many bytes each (matches txt/constants.py's PART_TARGET
// from the pre-InstantDB Python design).
export const PART_TARGET = 222 * 1024;

export const ORPHAN_PREVIEW_LIMIT = 50;
export const S3_DELETE_BATCH_SIZE = 1000; // AWS DeleteObjects hard limit
export const RETRY_DELAYS_MS = [2000, 4000, 8000]; // matches txt/r2.py's _RETRY_DELAYS

// Bounded concurrency for per-part R2 round-trips (uploading/downloading a
// document's txtParts) -- parts are prepared up front (pure, no I/O), then
// issued this many at a time rather than one giant unbounded Promise.all
// (risks exhausting connections/hitting rate limits) or a fully serial loop
// (slow for anything beyond a handful of parts).
export const R2_BATCH_CONCURRENCY = 15;

// bucket.ts/updateDbCatalog.ts/updateDbPrefixHash.ts page through `txt`/
// `txtParts` rows (tens of thousands for a large corpus) rather than one
// unpaginated query -- InstantDB enforces its own query timeout, and a
// single query over that many rows risks exceeding it.
export const INSTAQL_QUERY_PAGE_SIZE = 1000;

// Byte lengths and blob-format fields. See docs/crypto.md (blob format,
// shared by both --clean-bucket's schema and the InstantDB design in
// docs/data_model.md) and, for --clean-bucket specifically, docs/data_model.md
// as of commit 1ed39d433365c39a6973303c171c7bb5510d7e3e (the actual running
// schema at that point, not this branch's InstantDB design docs).

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

export const TXT_METADATA_LEGACY_THRESHOLD = 200;
export const USERNAME_LOOKUP_KEY_MIN_LEN = 32;
export const USER_ROOT_KEY_MIN_LEN = 256;

// docs/data_model.md's per-user SQLCipher database. Must be set via
// `PRAGMA cipher_default_page_size` before keying on every open (create or
// reopen) -- this codec has no plaintext header for SQLite to sniff the
// actual page size from otherwise, unlike an unencrypted database.
export const SQLCIPHER_PAGE_SIZE = 32768;

export const ORPHAN_PREVIEW_LIMIT = 50;
export const S3_DELETE_BATCH_SIZE = 1000; // AWS DeleteObjects hard limit
export const RETRY_DELAYS_MS = [2000, 4000, 8000]; // matches txt/r2.py's _RETRY_DELAYS

// Bounded concurrency for per-page R2/InstantDB round-trips (RemotePageStore's
// upload, R2Vfs's prefetch) -- pages are prepared up front (pure, no I/O),
// then issued this many at a time rather than one giant unbounded Promise.all
// (risks exhausting connections/hitting rate limits) or a fully serial loop
// (slow for anything beyond a handful of pages).
export const R2_BATCH_CONCURRENCY = 15;

// migrate.ts's collectKnownRawPaths pages through an account's own `pages`
// rows (tens of thousands for a large vault) rather than one unpaginated
// query -- InstantDB enforces its own query timeout, and a single query
// over that many rows risks exceeding it.
export const PAGES_QUERY_PAGE_SIZE = 500;

// migrate.ts fetches/decrypts/inserts this many source documents at a time
// (each document's own parts fetched in parallel too, R2_BATCH_CONCURRENCY
// at once) instead of downloading every remaining document's content into
// memory before inserting any of it -- bounds peak memory for a large
// backlog and gets useful local-DB progress sooner.
export const MIGRATE_BATCH_SIZE = 10;

// migrate.ts commits at most this many txt_parts rows (and whatever pages
// they end up touching) per R2/InstantDB commit -- one commit per whole
// txt_id blew up a real document with many parts into a single db.transact()
// with too many pages ("The query took too long to complete", confirmed
// against a real InstantDB app). A document with more parts than this gets
// multiple commits instead of one.
export const MIGRATE_PARTS_PER_COMMIT = 20;

// lazyPageWorker.ts prefetches pages numbered 1..min(this, pageCount) as one
// batched InstantDB query + batched R2 GETs the moment it starts, before
// SQLite's own xRead ever asks for a single page -- computeResumePlans'
// index scans over an existing, possibly large target account otherwise pay
// a full query+GET round trip per page, one at a time, serially (lazyVfs.ts
// has no way to know ahead of time which page numbers SQLite will touch, but
// low-numbered pages -- schema page 1, early btree/index pages -- are
// disproportionately likely to be touched early and often regardless of
// which txt_id/txt_parts rows a given run actually needs). Anything not
// covered by this cache still falls back to fetchPage's own one-at-a-time
// path unchanged.
export const MIGRATE_PREFETCH_PAGE_COUNT = 1000;

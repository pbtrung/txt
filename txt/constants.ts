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

export const TXT_METADATA_LEGACY_THRESHOLD = 200;
export const USERNAME_LOOKUP_KEY_MIN_LEN = 32;
export const USER_ROOT_KEY_MIN_LEN = 256;

export const ORPHAN_PREVIEW_LIMIT = 50;
export const S3_DELETE_BATCH_SIZE = 1000; // AWS DeleteObjects hard limit
export const RETRY_DELAYS_MS = [2000, 4000, 8000]; // matches txt/r2.py's _RETRY_DELAYS

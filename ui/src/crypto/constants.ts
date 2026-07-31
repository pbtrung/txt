// Byte lengths and blob-format fields, mirroring txt/constants.py 1:1.
// See docs/crypto.md and docs/data_model.md.

export const MAGIC = Uint8Array.of(0x54, 0x58);
export const VERSION = Uint8Array.of(0x01, 0x00);

export const SALT_LEN = 64;
export const TAG_LEN = 64;
export const KEY_LEN = 64;
export const IV_LEN = 64;
export const OKM_LEN = KEY_LEN + IV_LEN;
export const HEADER_LEN = MAGIC.length + VERSION.length;
export const AD_LEN = HEADER_LEN + SALT_LEN;
export const BLOB_MIN_LEN = AD_LEN + TAG_LEN;

export const TXT_KEY_LEN = 128; // txt.txt_key: 128 random bytes (docs/data_model.md)

// Matches trg_txt_bookmarks_cap's own cap -- documentation only here: the
// schema trigger enforces this server-side, nothing in ui/ needs to count
// towards it itself (see bookmarks.ts).
export const BOOKMARK_LIMIT = 20;

export const PART_TARGET = 222 * 1024;
export const RAW_PATH_LEN = 32; // random bytes for each part's R2 object key

export const R2_NUM_THREADS = 10; // max concurrent R2 fetches (see src/data/r2.ts)

export const BROTLI_QUALITY = 11; // max brotli compression level (see src/crypto/brotli.ts)

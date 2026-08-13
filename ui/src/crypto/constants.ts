// Byte lengths and blob-format fields, mirroring txt/constants.ts's own
// constants 1:1. See docs/crypto.md.

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

export const BROTLI_QUALITY = 11; // max brotli compression level (see src/crypto/brotli.ts)

// docs/key_hierarchy.md: every symmetric wrapping/content key in the current
// design (umk, keyStore.keyStoreKey, credStore.credStoreKey, txt.txtKey,
// txtParts.txtPartKey, txtAccess.txtAccessKey, txtBookmarks.txtBookmarkKey)
// is 128 random bytes -- mirrors txt/constants.ts's own RANDOM_KEY_LEN.
export const RANDOM_KEY_LEN = 128;

// docs/data_model.md's txt.prefix / txtParts.path: both are a
// Crockford-base32-lowercase encoding of this many random bytes -- mirrors
// txt/constants.ts's own RAW_TOKEN_LEN.
export const RAW_TOKEN_LEN = 32;

// Bounded R2 upload concurrency for adminShares.ts's grantShare, mirroring
// txt/constants.ts's own R2_BATCH_CONCURRENCY (ingest.ts's uploadParts) --
// same reasoning, just running in the browser instead of the CLI.
export const R2_BATCH_CONCURRENCY = 15;

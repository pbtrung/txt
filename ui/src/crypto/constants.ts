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

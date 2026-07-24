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

export const UMK_LEN = 64;
export const TXT_KEY_LEN = 64;
export const TXT_METADATA_KEY_LEN = 64;
export const TXT_ACCESS_KEY_LEN = 64;
export const BOOKMARK_KEY_LEN = 64;

export const PW_SALT_LEN = 32;
export const PBKDF2_ITERATIONS = 1_000;
export const PW_HASH_LEN = 64;
export const USERNAME_HASH_LEN = 32;

export const USERNAME_LOOKUP_KEY_MIN_LEN = 32;
export const USER_ROOT_KEY_MIN_LEN = 256;

// Composite ML-KEM-1024 + X448 (see docs/crypto.md's Composite KEM Key Sizes)
export const KYBER1024_PK_LEN = 1568;
export const KYBER1024_SK_LEN = 3168;
export const KYBER1024_CT_LEN = 1568;
export const KYBER1024_SS_LEN = 32;
export const X448_LEN = 56; // X448's public key, private key, and shared secret are all 56 bytes
export const KEM_PK_LEN = KYBER1024_PK_LEN + X448_LEN;
export const KEM_SK_LEN = KYBER1024_SK_LEN + X448_LEN;
export const KEM_CT_LEN = KYBER1024_CT_LEN + X448_LEN;
// Raw lc_kyber_1024_x448_ss struct: Kyber-SS || X448-SS, uncombined (see crypto.md)
export const KEM_SS_LEN = KYBER1024_SS_LEN + X448_LEN;

export const BOOKMARK_LIMIT = 20;
// Max distinct txt_ids tracked in txt_access.access -- client-enforced only,
// no equivalent constant on the Python side (see docs/data_model.md).
export const TXT_ACCESS_LIMIT = 7;

export const PART_TARGET = 222 * 1024;
export const RAW_PATH_LEN = 32; // random bytes for each part's R2 object key

// txt_metadata.content is a wrapped R2 path (~184 bytes: BLOB_MIN_LEN + a
// ~52-char base32 path) once migrated; anything at/above this length is
// still the pre-migration inline-JSON format (see docs/data_model.md).
export const TXT_METADATA_LEGACY_THRESHOLD = 200;

export const R2_NUM_THREADS = 10; // max concurrent R2 fetches (see src/data/r2.ts)

export const BROTLI_QUALITY = 11; // max brotli compression level (see src/crypto/brotli.ts)

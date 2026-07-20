"""Byte lengths and blob-format fields. See docs/crypto.md and docs/data_model.md."""

MAGIC = b"\x54\x58"
VERSION = b"\x01\x00"

SALT_LEN = 64
TAG_LEN = 64
KEY_LEN = 64
IV_LEN = 64
OKM_LEN = KEY_LEN + IV_LEN
AD_LEN = len(MAGIC) + len(VERSION) + SALT_LEN
BLOB_MIN_LEN = AD_LEN + TAG_LEN

UMK_LEN = 64
TXT_KEY_LEN = 64
TXT_METADATA_KEY_LEN = 64

PW_SALT_LEN = 32
PBKDF2_ITERATIONS = 1_000
PW_HASH_LEN = 64
USERNAME_HASH_LEN = 32

USERNAME_LOOKUP_KEY_MIN_LEN = 32
USER_ROOT_KEY_MIN_LEN = 256

# Composite ML-KEM-1024 + X448 (see docs/crypto.md's Composite KEM Key Sizes)
KYBER1024_PK_LEN = 1568
KYBER1024_SK_LEN = 3168
KYBER1024_CT_LEN = 1568
KYBER1024_SS_LEN = 32
X448_LEN = 56  # X448's public key, private key, and shared secret are all 56 bytes
KEM_PK_LEN = KYBER1024_PK_LEN + X448_LEN
KEM_SK_LEN = KYBER1024_SK_LEN + X448_LEN
KEM_CT_LEN = KYBER1024_CT_LEN + X448_LEN
# Raw lc_kyber_1024_x448_ss struct: Kyber-SS || X448-SS, uncombined (see crypto.md)
KEM_SS_LEN = KYBER1024_SS_LEN + X448_LEN

BOOKMARK_LIMIT = 20

PART_TARGET = 200 * 1024  # ~200 KB target size per txt_parts.path chunk

R2_NUM_THREADS = 10  # max concurrent R2 upload/download threads (see txt/r2.py)

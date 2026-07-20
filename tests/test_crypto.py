"""Unit tests for txt/crypto.py: the blob format, AEAD, KDF, and KEM primitives
(see docs/crypto.md). Exercises the real leancrypto bindings, not a mock.
"""

import os

import pytest

from txt import constants as c
from txt.crypto import (
    Blob,
    Kem,
    LeanCryptoError,
    _check,
    hkdf,
    hmac_sha3_256,
    pbkdf2_sha3_256,
)

IKM = os.urandom(c.UMK_LEN)


# -- _check -------------------------------------------------------------


def test_check_zero_does_not_raise():
    _check(0, "noop")


def test_check_nonzero_raises_leancryptoerror():
    with pytest.raises(LeanCryptoError, match=r"^boom failed: 1$"):
        _check(1, "boom")


# -- hkdf -----------------------------------------------------------------


def test_hkdf_returns_requested_length():
    assert len(hkdf(b"ikm", os.urandom(c.SALT_LEN), 48)) == 48


def test_hkdf_deterministic_for_same_inputs():
    salt = os.urandom(c.SALT_LEN)
    assert hkdf(b"ikm", salt, 32) == hkdf(b"ikm", salt, 32)


def test_hkdf_differs_for_different_salt():
    a = hkdf(b"ikm", b"s" * c.SALT_LEN, 32)
    b = hkdf(b"ikm", b"t" * c.SALT_LEN, 32)
    assert a != b


# -- hmac_sha3_256 --------------------------------------------------------


def test_hmac_sha3_256_returns_username_hash_len():
    assert len(hmac_sha3_256(os.urandom(32), b"alice")) == c.USERNAME_HASH_LEN


def test_hmac_sha3_256_deterministic():
    key = os.urandom(32)
    assert hmac_sha3_256(key, b"alice") == hmac_sha3_256(key, b"alice")


def test_hmac_sha3_256_differs_for_different_data():
    key = os.urandom(32)
    assert hmac_sha3_256(key, b"alice") != hmac_sha3_256(key, b"bob")


# -- pbkdf2_sha3_256 ------------------------------------------------------


def test_pbkdf2_sha3_256_returns_requested_keylen():
    out = pbkdf2_sha3_256(b"hunter2", os.urandom(c.PW_SALT_LEN), 2, c.PW_HASH_LEN)
    assert len(out) == c.PW_HASH_LEN


def test_pbkdf2_sha3_256_deterministic():
    salt = os.urandom(c.PW_SALT_LEN)
    a = pbkdf2_sha3_256(b"hunter2", salt, 2, 32)
    b = pbkdf2_sha3_256(b"hunter2", salt, 2, 32)
    assert a == b


def test_pbkdf2_sha3_256_differs_for_different_password():
    salt = os.urandom(c.PW_SALT_LEN)
    a = pbkdf2_sha3_256(b"hunter2", salt, 2, 32)
    b = pbkdf2_sha3_256(b"correct horse battery staple", salt, 2, 32)
    assert a != b


# -- Blob.encrypt / Blob.decrypt ------------------------------------------


def test_blob_roundtrip_uncompressed():
    payload = b"hello world"
    blob = Blob.encrypt(IKM, payload)
    assert Blob.decrypt(IKM, blob) == payload


def test_blob_roundtrip_compressed():
    payload = b'{"a": 1, "b": [1, 2, 3]}'
    blob = Blob.encrypt(IKM, payload, compressed=True)
    assert Blob.decrypt(IKM, blob, compressed=True) == payload


def test_blob_encrypt_uses_random_salt_by_default():
    a = Blob.encrypt(IKM, b"same payload")
    b = Blob.encrypt(IKM, b"same payload")
    assert a != b


def test_blob_encrypt_accepts_explicit_salt():
    salt = os.urandom(c.SALT_LEN)
    a = Blob.encrypt(IKM, b"same payload", salt=salt)
    b = Blob.encrypt(IKM, b"same payload", salt=salt)
    assert a == b


def test_blob_format_fields():
    salt = os.urandom(c.SALT_LEN)
    payload = b"payload"
    blob = Blob.encrypt(IKM, payload, salt=salt)
    assert blob[:2] == c.MAGIC
    assert blob[2:4] == c.VERSION
    assert blob[4 : c.AD_LEN] == salt
    assert len(blob) == c.AD_LEN + len(payload) + c.TAG_LEN


def test_blob_decrypt_rejects_short_blob():
    with pytest.raises(ValueError, match="shorter than minimum"):
        Blob.decrypt(IKM, b"\x00" * (c.BLOB_MIN_LEN - 1))


def test_blob_decrypt_rejects_bad_magic():
    blob = Blob.encrypt(IKM, b"payload")
    tampered = b"\xff\xff" + blob[2:]
    with pytest.raises(ValueError, match="bad magic"):
        Blob.decrypt(IKM, tampered)


def test_blob_decrypt_rejects_unsupported_version():
    blob = Blob.encrypt(IKM, b"payload")
    tampered = blob[:2] + b"\xff" + blob[3:]
    with pytest.raises(ValueError, match="unsupported major version"):
        Blob.decrypt(IKM, tampered)


def test_blob_decrypt_rejects_tampered_ciphertext():
    blob = Blob.encrypt(IKM, b"payload")
    flipped = bytearray(blob)
    flipped[c.AD_LEN] ^= 0xFF
    with pytest.raises(ValueError, match="AEAD tag verification failed"):
        Blob.decrypt(IKM, bytes(flipped))


def test_blob_decrypt_rejects_tampered_tag():
    blob = Blob.encrypt(IKM, b"payload")
    flipped = bytearray(blob)
    flipped[-1] ^= 0xFF
    with pytest.raises(ValueError, match="AEAD tag verification failed"):
        Blob.decrypt(IKM, bytes(flipped))


def test_blob_decrypt_rejects_wrong_ikm():
    blob = Blob.encrypt(IKM, b"payload")
    with pytest.raises(ValueError, match="AEAD tag verification failed"):
        Blob.decrypt(os.urandom(c.UMK_LEN), blob)


# -- Kem -------------------------------------------------------------------


def test_kem_keypair_lengths():
    pk, sk = Kem.keypair()
    assert len(pk) == c.KEM_PK_LEN
    assert len(sk) == c.KEM_SK_LEN


def test_kem_encapsulate_decapsulate_roundtrip():
    pk, sk = Kem.keypair()
    ct, ss = Kem.encapsulate(pk)
    assert len(ct) == c.KEM_CT_LEN
    assert len(ss) == c.KEM_SS_LEN
    assert Kem.decapsulate(sk, ct) == ss


def test_kem_wrap_unwrap_roundtrip():
    pk, sk = Kem.keypair()
    payload = os.urandom(c.TXT_KEY_LEN)
    salt_kem_ct, blob = Kem.wrap(pk, payload)
    assert len(salt_kem_ct) == c.SALT_LEN + c.KEM_CT_LEN
    assert Kem.unwrap(sk, salt_kem_ct, blob) == payload


def test_kem_unwrap_fails_with_wrong_priv_key():
    pk, _sk = Kem.keypair()
    _pk2, sk2 = Kem.keypair()
    salt_kem_ct, blob = Kem.wrap(pk, b"secret")
    with pytest.raises(ValueError, match="AEAD tag verification failed"):
        Kem.unwrap(sk2, salt_kem_ct, blob)

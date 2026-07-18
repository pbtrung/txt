"""Blob format, AEAD/KDF/KEM primitives (see docs/crypto.md)."""

import os
import ctypes

from . import constants as c
from .leancrypto import lib as _lib, sha3_512 as _sha3_512, sha3_256 as _sha3_256
from .leancrypto import seeded_rng as _rng


class LeanCryptoError(RuntimeError):
    """A leancrypto C call returned a non-zero status."""


def _check(ret: int, what: str) -> None:
    if ret != 0:
        raise LeanCryptoError(f"{what} failed: {ret}")


def hkdf(ikm: bytes, salt: bytes, length: int) -> bytes:
    """HKDF-SHA3-512(ikm, salt) -> length bytes of OKM."""
    out = ctypes.create_string_buffer(length)
    ret = _lib.lc_hkdf(_sha3_512, ikm, len(ikm), salt, len(salt), None, 0, out, length)
    _check(ret, "lc_hkdf")
    return bytes(out)


def hmac_sha3_256(key: bytes, data: bytes) -> bytes:
    """HMAC-SHA3-256(key, data), used for username_hash."""
    out = ctypes.create_string_buffer(c.USERNAME_HASH_LEN)
    ret = _lib.lc_hmac(_sha3_256, key, len(key), data, len(data), out)
    _check(ret, "lc_hmac")
    return bytes(out)


def pbkdf2_sha3_256(password: bytes, salt: bytes, iterations: int, keylen: int) -> bytes:
    """PBKDF2-HMAC-SHA3-256(password, salt, iterations) -> keylen bytes, used for pw_hash."""
    out = ctypes.create_string_buffer(keylen)
    ret = _lib.lc_pbkdf2(_sha3_256, password, len(password), salt, len(salt), iterations, out, keylen)
    _check(ret, "lc_pbkdf2")
    return bytes(out)


class Blob:
    """Encrypt/Decrypt per crypto.md's blob format: magic||version||salt||ciphertext||tag."""

    @staticmethod
    def _aead_ctx(key: bytes, iv: bytes) -> ctypes.c_void_p:
        ctx = ctypes.c_void_p(None)
        _check(_lib.lc_ak_alloc_taglen(_sha3_512, c.TAG_LEN, ctypes.byref(ctx)), "lc_ak_alloc_taglen")
        _check(_lib.lc_aead_setkey(ctx, key, len(key), iv, len(iv)), "lc_aead_setkey")
        return ctx

    @staticmethod
    def _derive(ikm: bytes, salt: bytes) -> tuple[bytes, bytes]:
        okm = hkdf(ikm, salt, c.OKM_LEN)
        return okm[: c.KEY_LEN], okm[c.KEY_LEN :]

    @classmethod
    def encrypt(cls, ikm: bytes, payload: bytes) -> bytes:
        salt = os.urandom(c.SALT_LEN)
        key, iv = cls._derive(ikm, salt)
        ad = c.MAGIC + c.VERSION + salt
        ctx = cls._aead_ctx(key, iv)
        try:
            ct = ctypes.create_string_buffer(len(payload))
            tag = ctypes.create_string_buffer(c.TAG_LEN)
            ret = _lib.lc_aead_encrypt(ctx, payload, ct, len(payload), ad, len(ad), tag, c.TAG_LEN)
            _check(ret, "lc_aead_encrypt")
            return ad + bytes(ct) + bytes(tag)
        finally:
            _lib.lc_aead_zero_free(ctx)

    @classmethod
    def decrypt(cls, ikm: bytes, blob: bytes) -> bytes:
        if len(blob) < c.BLOB_MIN_LEN:
            raise ValueError("blob shorter than minimum valid length")
        if blob[:2] != c.MAGIC:
            raise ValueError("bad magic")
        if blob[2:3] != c.VERSION[:1]:
            raise ValueError("unsupported major version")
        ad, salt = blob[: c.AD_LEN], blob[4 : c.AD_LEN]
        ct, tag = blob[c.AD_LEN : -c.TAG_LEN], blob[-c.TAG_LEN :]
        key, iv = cls._derive(ikm, salt)
        ctx = cls._aead_ctx(key, iv)
        try:
            pt = ctypes.create_string_buffer(len(ct))
            if _lib.lc_aead_decrypt(ctx, ct, pt, len(ct), ad, len(ad), tag, len(tag)) != 0:
                raise ValueError("AEAD tag verification failed")
            return bytes(pt)
        finally:
            _lib.lc_aead_zero_free(ctx)


class Kem:
    """Composite ML-KEM-1024 + X448 keypair, Encapsulate, and Decapsulate."""

    @staticmethod
    def keypair() -> tuple[bytes, bytes]:
        pk = ctypes.create_string_buffer(c.KEM_PK_LEN)
        sk = ctypes.create_string_buffer(c.KEM_SK_LEN)
        _check(_lib.lc_kyber_1024_x448_keypair(pk, sk, _rng), "lc_kyber_1024_x448_keypair")
        return bytes(pk), bytes(sk)

    @staticmethod
    def encapsulate(pub_key: bytes) -> tuple[bytes, bytes]:
        ct = ctypes.create_string_buffer(c.KEM_CT_LEN)
        ss = ctypes.create_string_buffer(c.KEM_SS_LEN)
        ret = _lib.lc_kyber_1024_x448_enc_kdf(ct, ss, c.KEM_SS_LEN, pub_key)
        _check(ret, "lc_kyber_1024_x448_enc_kdf")
        return bytes(ct), bytes(ss)

    @staticmethod
    def decapsulate(priv_key: bytes, ct: bytes) -> bytes:
        ss = ctypes.create_string_buffer(c.KEM_SS_LEN)
        ret = _lib.lc_kyber_1024_x448_dec_kdf(ss, c.KEM_SS_LEN, ct, priv_key)
        _check(ret, "lc_kyber_1024_x448_dec_kdf")
        return bytes(ss)

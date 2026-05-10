import os
import ctypes
import hmac as _hmac
import brotli
from .constants import SALT_LEN, TAG_LEN, KEY_LEN, IV_LEN, HMAC_LEN
from .leancrypto import lib as _lib, sha3_512 as _sha3_512, sha3_256 as _sha3_256


class Crypto:
    """All cryptographic operations: primitives, key derivation, encrypt/decrypt."""

    def __init__(self, master_key: bytes):
        self._mk = master_key

    def _hkdf(self, ikm: bytes, salt: bytes, length: int) -> bytes:
        out = ctypes.create_string_buffer(length)
        ret = _lib.lc_hkdf(
            _sha3_512, ikm, len(ikm), salt, len(salt), None, 0, out, length
        )
        if ret != 0:
            raise RuntimeError(f"lc_hkdf failed: {ret}")
        return bytes(out)

    def _hmac(self, key: bytes, data: bytes) -> bytes:
        out = ctypes.create_string_buffer(HMAC_LEN)
        ret = _lib.lc_hmac(_sha3_256, key, len(key), data, len(data), out)
        if ret != 0:
            raise RuntimeError(f"lc_hmac failed: {ret}")
        return bytes(out)

    def _aead_alloc(self):
        ctx = ctypes.c_void_p(None)
        ret = _lib.lc_ak_alloc_taglen(_sha3_512, TAG_LEN, ctypes.byref(ctx))
        if ret != 0:
            raise RuntimeError(f"lc_ak_alloc_taglen failed: {ret}")
        return ctx

    def _aead_encrypt(self, key: bytes, iv: bytes, pt: bytes, aad: bytes) -> bytes:
        ctx = self._aead_alloc()
        try:
            if _lib.lc_aead_setkey(ctx, key, len(key), iv, len(iv)) != 0:
                raise RuntimeError("lc_aead_setkey failed")
            ct = ctypes.create_string_buffer(len(pt))
            tag = ctypes.create_string_buffer(TAG_LEN)
            if (
                _lib.lc_aead_encrypt(ctx, pt, ct, len(pt), aad, len(aad), tag, TAG_LEN)
                != 0
            ):
                raise RuntimeError("lc_aead_encrypt failed")
            return bytes(ct) + bytes(tag)
        finally:
            _lib.lc_aead_zero_free(ctx)

    def _aead_decrypt(self, key: bytes, iv: bytes, ct_tag: bytes, aad: bytes) -> bytes:
        ctx = self._aead_alloc()
        try:
            if _lib.lc_aead_setkey(ctx, key, len(key), iv, len(iv)) != 0:
                raise RuntimeError("lc_aead_setkey failed")
            ct, tag = ct_tag[:-TAG_LEN], ct_tag[-TAG_LEN:]
            pt = ctypes.create_string_buffer(len(ct))
            if (
                _lib.lc_aead_decrypt(ctx, ct, pt, len(ct), aad, len(aad), tag, len(tag))
                != 0
            ):
                raise ValueError("AEAD tag verification failed")
            return bytes(pt)
        finally:
            _lib.lc_aead_zero_free(ctx)

    def _derive_part(self, salt: bytes) -> tuple[bytes, bytes]:
        okm = self._hkdf(self._mk, salt, KEY_LEN + IV_LEN)
        return okm[:KEY_LEN], okm[KEY_LEN:]

    def _derive_name(self, salt: bytes) -> tuple[bytes, bytes, bytes]:
        okm = self._hkdf(self._mk, salt, KEY_LEN + IV_LEN + HMAC_LEN)
        return okm[:KEY_LEN], okm[KEY_LEN : KEY_LEN + IV_LEN], okm[KEY_LEN + IV_LEN :]

    def encrypt_part(self, plaintext: bytes) -> bytes:
        compressed = brotli.compress(plaintext, quality=11)
        salt = os.urandom(SALT_LEN)
        key, iv = self._derive_part(salt)
        return salt + self._aead_encrypt(key, iv, compressed, salt)

    def decrypt_part(self, blob: bytes) -> bytes:
        salt, ct_tag = blob[:SALT_LEN], blob[SALT_LEN:]
        key, iv = self._derive_part(salt)
        return brotli.decompress(self._aead_decrypt(key, iv, ct_tag, salt))

    def encrypt_name(self, name: str) -> tuple[bytes, bytes]:
        name_b = name.encode()
        salt = os.urandom(SALT_LEN)
        key, iv, hmac_key = self._derive_name(salt)
        blob = salt + self._aead_encrypt(key, iv, name_b, salt)
        return blob, self._hmac(hmac_key, name_b)

    def find_txt_id(self, conn, name: str) -> int | None:
        name_b = name.encode()
        for row_id, name_blob, stored_mac in conn.execute(
            "SELECT id, name, name_hmac FROM txt"
        ).fetchall():
            salt = bytes(name_blob)[:SALT_LEN]
            _, _, hmac_key = self._derive_name(salt)
            if _hmac.compare_digest(self._hmac(hmac_key, name_b), bytes(stored_mac)):
                return row_id
        return None

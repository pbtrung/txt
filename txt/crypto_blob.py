import json
import secrets

import brotli

from .leancrypto_wasm import LeancryptoEngine

MAGIC = b"\x54\x58"
VERSION = b"\x01\x00"
MIN_BLOB_LEN = 132

# docs/crypto.md's Additional Data section: context is not yet implemented,
# so AD is magic||version||salt only and HKDF's info is always empty.
_INFO = b""


class CryptoBlob:
    def __init__(self, engine: LeancryptoEngine):
        self.engine = engine

    def encrypt(self, plaintext: bytes, ikm: bytes) -> bytes:
        salt = secrets.token_bytes(64)
        key, iv = self._derive(ikm, salt)
        ad = MAGIC + VERSION + salt
        ciphertext, tag = self.engine.aead_encrypt(key, iv, ad, plaintext)
        return MAGIC + VERSION + salt + ciphertext + tag

    def decrypt(self, blob: bytes, ikm: bytes) -> bytes:
        if len(blob) < MIN_BLOB_LEN:
            raise ValueError(f"blob too short: {len(blob)} < {MIN_BLOB_LEN}")
        magic, version, salt = blob[0:2], blob[2:4], blob[4:68]
        ciphertext, tag = blob[68:-64], blob[-64:]
        if magic != MAGIC:
            raise ValueError("bad magic")
        if version[0] != VERSION[0]:
            raise ValueError(f"unsupported major version: {version[0]}")
        key, iv = self._derive(ikm, salt)
        return self.engine.aead_decrypt(
            key, iv, magic + version + salt, ciphertext, tag
        )

    def encrypt_json(self, payload: dict, ikm: bytes) -> bytes:
        return self.encrypt(brotli.compress(json.dumps(payload).encode()), ikm)

    def decrypt_json(self, blob: bytes, ikm: bytes) -> dict:
        return json.loads(brotli.decompress(self.decrypt(blob, ikm)))

    def _derive(self, ikm: bytes, salt: bytes) -> tuple[bytes, bytes]:
        okm = self.engine.hkdf_sha3_512(ikm, salt, _INFO, 128)
        return okm[:64], okm[64:]

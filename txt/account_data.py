import base64
import binascii
import hashlib
from dataclasses import dataclass

from .random_token import CROCKFORD_ALPHABET


@dataclass(frozen=True)
class StorageAccount:
    uid: str
    db_master_key: bytes
    db_path: str
    db_prefix: str


def parse_storage_account(uid: str, payload: dict) -> StorageAccount:
    return StorageAccount(
        uid=uid,
        db_master_key=_decode_master_key(uid, payload.get("db_master_key")),
        db_path=_storage_path(uid, "db_path", payload.get("db_path")),
        db_prefix=_storage_path(uid, "db_prefix", payload.get("db_prefix")),
    )


def storage_binding(account: StorageAccount) -> bytes:
    paths = (account.db_path + account.db_prefix).encode()
    return hashlib.sha512(paths).digest()


def _decode_master_key(uid: str, value: object) -> bytes:
    if not isinstance(value, str):
        raise _invalid(uid, "db_master_key")
    try:
        key = base64.b64decode(value, validate=True)
    except ValueError, binascii.Error:
        raise _invalid(uid, "db_master_key") from None
    if len(key) != 256:
        raise _invalid(uid, "db_master_key")
    return key


def _storage_path(uid: str, name: str, value: object) -> str:
    if not isinstance(value, str) or len(value) != 52:
        raise _invalid(uid, name)
    if any(char not in CROCKFORD_ALPHABET for char in value):
        raise _invalid(uid, name)
    return value


def _invalid(uid: str, field: str) -> ValueError:
    return ValueError(f"Account uid={uid} has an invalid {field}")

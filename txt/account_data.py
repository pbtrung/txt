import base64
from dataclasses import dataclass

from .random_token import CROCKFORD_ALPHABET


@dataclass(frozen=True)
class OwnerAccount:
    db_prefix: str
    user_handle: bytes
    display_name: str


def parse_owner_account(payload: dict) -> OwnerAccount:
    return OwnerAccount(
        db_prefix=_storage_path("db_prefix", payload.get("db_prefix")),
        user_handle=_decode_user_handle(payload.get("user_handle")),
        display_name=_require_display_name(payload.get("display_name")),
    )


def _decode_user_handle(value: object) -> bytes:
    if not isinstance(value, str):
        raise _invalid("user_handle")
    try:
        handle = base64.b64decode(value, validate=True)
    except ValueError:
        raise _invalid("user_handle") from None
    if len(handle) != 32:
        raise _invalid("user_handle")
    return handle


def _storage_path(name: str, value: object) -> str:
    if not isinstance(value, str) or len(value) != 52:
        raise _invalid(name)
    if any(char not in CROCKFORD_ALPHABET for char in value):
        raise _invalid(name)
    return value


def _require_display_name(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise _invalid("display_name")
    return value


def _invalid(field: str) -> ValueError:
    return ValueError(f"owner credentials have an invalid {field}")

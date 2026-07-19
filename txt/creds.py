"""Loading and validating per-role credential JSON files (see docs/credentials.md)."""

import base64
import json
from dataclasses import dataclass
from pathlib import Path

from . import constants as c


@dataclass(slots=True, frozen=True)
class R2Config:
    """Cloudflare R2 connection info.

    Every role gets a read-only key pair; only the admin role also gets a
    read-write key pair (see docs/credentials.md).
    """

    endpoint: str
    region: str
    bucket: str
    read_only_access_key_id: str
    read_only_secret_access_key: str
    read_write_access_key_id: str | None = None
    read_write_secret_access_key: str | None = None

    @classmethod
    def load(cls, data: dict) -> "R2Config":
        return cls(
            endpoint=data["endpoint"],
            region=data["region"],
            bucket=data["bucket"],
            read_only_access_key_id=data["read_only_access_key_id"],
            read_only_secret_access_key=data["read_only_secret_access_key"],
            read_write_access_key_id=data.get("read_write_access_key_id") or None,
            read_write_secret_access_key=data.get("read_write_secret_access_key")
            or None,
        )


def _load_kwargs(path: Path) -> dict:
    data = json.loads(path.read_text())
    return dict(
        turso_database_url=data["turso_database_url"],
        turso_auth_token=data["turso_auth_token"],
        username=data["username"],
        username_lookup_key=base64.b64decode(data["username_lookup_key"]),
        password=data["password"],
        display_name=data["display_name"],
        user_root_key=base64.b64decode(data["user_root_key"]),
        r2_config=R2Config.load(data["r2_config"]),
    )


@dataclass(slots=True, frozen=True)
class Creds:
    """Turso connection info plus a user's per-user config secrets, common to every role."""

    turso_database_url: str
    turso_auth_token: str
    username: str
    username_lookup_key: bytes
    password: str
    display_name: str
    user_root_key: bytes
    r2_config: R2Config

    def __post_init__(self) -> None:
        if not self.username:
            raise ValueError("username is required")
        if len(self.username_lookup_key) < c.USERNAME_LOOKUP_KEY_MIN_LEN:
            raise ValueError("username_lookup_key too short")
        if not self.password:
            raise ValueError("password is required")
        if len(self.user_root_key) < c.USER_ROOT_KEY_MIN_LEN:
            raise ValueError("user_root_key too short")
        if not self.display_name:
            raise ValueError("display_name is required")


@dataclass(slots=True, frozen=True)
class AdminCreds(Creds):
    """Admin role: full (read-write) R2 keys, a read-write Turso token."""

    def __post_init__(self) -> None:
        super().__post_init__()
        if not (
            self.r2_config.read_write_access_key_id
            and self.r2_config.read_write_secret_access_key
        ):
            raise ValueError("admin creds must include r2_config read_write keys")

    @classmethod
    def load(cls, path: Path) -> "AdminCreds":
        return cls(**_load_kwargs(path))


@dataclass(slots=True, frozen=True)
class UserCreds(Creds):
    """Regular (non-admin) user role: read-only R2 keys only, no read-write pair.

    This role's turso_auth_token is likewise expected to be scoped read-only at
    the database level — Turso tokens are whole-database read-only/read-write,
    not per-table. The read-write access this role needs on `txt_access` and
    `bookmarks` is an application-level policy enforced by whatever mediates
    those writes, not something the token itself expresses (see
    docs/credentials.md).
    """

    def __post_init__(self) -> None:
        super().__post_init__()
        if (
            self.r2_config.read_write_access_key_id
            or self.r2_config.read_write_secret_access_key
        ):
            raise ValueError("user creds must not include r2_config read_write keys")

    @classmethod
    def load(cls, path: Path) -> "UserCreds":
        return cls(**_load_kwargs(path))

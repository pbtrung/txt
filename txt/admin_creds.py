"""Loading and validating admin_creds.json."""

import base64
import json
from dataclasses import dataclass
from pathlib import Path

from . import constants as c


@dataclass(slots=True, frozen=True)
class AdminCreds:
    """Turso connection info plus the admin user's per-user config secrets."""

    turso_database_url: str
    turso_auth_token: str
    username_lookup_key: bytes
    display_name: str
    user_root_key: bytes

    def __post_init__(self) -> None:
        if len(self.username_lookup_key) < c.USERNAME_LOOKUP_KEY_MIN_LEN:
            raise ValueError("username_lookup_key too short")
        if len(self.user_root_key) < c.USER_ROOT_KEY_MIN_LEN:
            raise ValueError("user_root_key too short")
        if not self.display_name:
            raise ValueError("display_name is required")

    @classmethod
    def load(cls, path: Path) -> "AdminCreds":
        data = json.loads(path.read_text())
        return cls(
            turso_database_url=data["turso_database_url"],
            turso_auth_token=data["turso_auth_token"],
            username_lookup_key=base64.b64decode(data["username_lookup_key"]),
            display_name=data["display_name"],
            user_root_key=base64.b64decode(data["user_root_key"]),
        )

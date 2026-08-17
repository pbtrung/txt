import base64
import hashlib

import pytest

from txt.account_data import parse_storage_account, storage_binding

UID = "uid-user"
DB_PATH = "a" * 52
DB_PREFIX = "b" * 52
DB_MASTER_KEY = b"k" * 256


def payload() -> dict:
    return {
        "db_master_key": base64.b64encode(DB_MASTER_KEY).decode(),
        "db_path": DB_PATH,
        "db_prefix": DB_PREFIX,
    }


def test_parses_and_binds_valid_storage_account():
    account = parse_storage_account(UID, payload())

    assert account.db_master_key == DB_MASTER_KEY
    expected = hashlib.sha512((DB_PATH + DB_PREFIX).encode()).digest()
    assert storage_binding(account) == expected


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("db_master_key", "not base64!"),
        ("db_master_key", base64.b64encode(b"short").decode()),
        ("db_path", "a" * 51),
        ("db_path", "u" * 52),
        ("db_prefix", "B" * 52),
    ],
)
def test_rejects_invalid_storage_fields(field, value):
    invalid = payload()
    invalid[field] = value

    with pytest.raises(ValueError, match=field):
        parse_storage_account(UID, invalid)

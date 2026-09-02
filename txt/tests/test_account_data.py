import base64

import pytest

from txt.account_data import parse_owner_account

DB_PREFIX = "b" * 52
USER_HANDLE = b"h" * 32


def payload() -> dict:
    return {
        "db_prefix": DB_PREFIX,
        "user_handle": base64.b64encode(USER_HANDLE).decode(),
        "display_name": "Owner",
    }


def test_parses_valid_owner_account():
    account = parse_owner_account(payload())

    assert account.db_prefix == DB_PREFIX
    assert account.user_handle == USER_HANDLE
    assert account.display_name == "Owner"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("db_prefix", "b" * 51),
        ("db_prefix", "B" * 52),
        ("user_handle", "not base64!"),
        ("user_handle", base64.b64encode(b"short").decode()),
        ("display_name", ""),
        ("display_name", 5),
    ],
)
def test_rejects_invalid_fields(field, value):
    invalid = payload()
    invalid[field] = value

    with pytest.raises(ValueError, match=field):
        parse_owner_account(invalid)

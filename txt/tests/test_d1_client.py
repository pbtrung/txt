import pytest

from txt.d1_client import D1Client, D1Error


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return FakeResponse(self.payload)


def _client(session):
    return D1Client("acct123", "db456", "token789", session=session)


def test_query_posts_to_the_account_and_database_scoped_url():
    session = FakeSession(
        {"success": True, "result": [{"success": True, "results": []}]}
    )

    _client(session).query("SELECT 1")

    url, options = session.calls[0]
    assert (
        url
        == "https://api.cloudflare.com/client/v4/accounts/acct123/d1/database/db456/query"
    )
    assert options["headers"] == {"Authorization": "Bearer token789"}


def test_query_decodes_a_blob_column_from_its_byte_array_form():
    session = FakeSession(
        {
            "success": True,
            "result": [
                {
                    "success": True,
                    "results": [{"id": 1, "wrapped_umk": [1, 2, 255]}],
                }
            ],
        }
    )

    rows = _client(session).query("SELECT id, wrapped_umk FROM owner")

    assert rows == [{"id": 1, "wrapped_umk": b"\x01\x02\xff"}]


def test_execute_hex_encodes_bytes_parameters_since_d1_params_are_strings_only():
    session = FakeSession({"success": True, "result": [{"success": True}]})

    _client(session).execute(
        "INSERT INTO t (name, content) VALUES (?, unhex(?))", ["a", b"\xde\xad"]
    )

    _url, options = session.calls[0]
    assert options["json"] == {
        "sql": "INSERT INTO t (name, content) VALUES (?, unhex(?))",
        "params": ["a", "dead"],
    }


def test_execute_rejects_a_non_str_non_bytes_parameter():
    session = FakeSession({"success": True, "result": [{"success": True}]})

    with pytest.raises(TypeError, match="str or bytes"):
        _client(session).execute("INSERT INTO t (id) VALUES (?)", [5])


def test_query_one_returns_none_for_no_rows():
    session = FakeSession(
        {"success": True, "result": [{"success": True, "results": []}]}
    )

    assert _client(session).query_one("SELECT 1 WHERE 0") is None


def test_execute_returns_the_full_result_entry_for_last_row_id_access():
    session = FakeSession(
        {"success": True, "result": [{"success": True, "meta": {"last_row_id": 7}}]}
    )

    result = _client(session).execute("INSERT INTO t DEFAULT VALUES")

    assert result["meta"]["last_row_id"] == 7


def test_top_level_failure_raises_d1_error_with_the_message():
    session = FakeSession(
        {
            "success": False,
            "errors": [{"code": 7500, "message": "syntax error"}],
            "result": [],
        }
    )

    with pytest.raises(D1Error, match="syntax error"):
        _client(session).query("BOGUS SQL")


def test_per_statement_failure_raises_d1_error():
    session = FakeSession(
        {
            "success": True,
            "result": [{"success": False, "error": "table already exists"}],
        }
    )

    with pytest.raises(D1Error):
        _client(session).execute("CREATE TABLE t (id)")


def test_malformed_response_without_a_result_list_raises_d1_error():
    session = FakeSession({"success": True})

    with pytest.raises(D1Error, match="malformed"):
        _client(session).query("SELECT 1")

import pytest

from txt.rqlite_client import RqliteClient, RqliteError


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


def test_query_uses_operator_proxy_basic_auth_and_decodes_blobs():
    session = FakeSession(
        {
            "results": [
                {
                    "columns": ["firebase_uid", "wrapped_umk"],
                    "values": [["owner", [1, 2, 255]]],
                }
            ]
        }
    )
    client = RqliteClient(
        "https://api.example.com/operator/rqlite/",
        "operator",
        "secret",
        session=session,
    )

    row = client.query_one(
        "SELECT * FROM owner_control WHERE singleton = :id", {"id": 1}
    )

    assert row == {"firebase_uid": "owner", "wrapped_umk": b"\x01\x02\xff"}
    url, options = session.calls[0]
    assert url.endswith("/operator/rqlite/db/query?level=strong&blob_array")
    assert options["auth"] == ("operator", "secret")
    assert options["json"] == [
        ["SELECT * FROM owner_control WHERE singleton = :id", {"id": 1}]
    ]


def test_execute_encodes_blob_parameters_as_byte_arrays():
    session = FakeSession({"results": [{}]})
    client = RqliteClient(
        "https://api.example.com/operator/rqlite", "u", "p", session=session
    )

    client.execute("INSERT INTO t (content) VALUES (:content)", {"content": b"abc"})

    _url, options = session.calls[0]
    assert options["json"][0][1]["content"] == [97, 98, 99]


def test_execute_batch_sends_one_transactional_request():
    session = FakeSession({"results": [{}, {}]})
    client = RqliteClient(
        "https://api.example.com/operator/rqlite", "u", "p", session=session
    )

    client.execute_batch(("CREATE TABLE a (id)", "CREATE TABLE b (id)"))

    url, options = session.calls[0]
    assert url.endswith("/db/execute?transaction")
    assert options["json"] == [
        ["CREATE TABLE a (id)", {}],
        ["CREATE TABLE b (id)", {}],
    ]


def test_vacuum_omits_the_transaction_flag_sqlite_forbids_it_under():
    session = FakeSession({"results": [{}]})
    client = RqliteClient(
        "https://api.example.com/operator/rqlite", "u", "p", session=session
    )

    client.vacuum()

    url, options = session.calls[0]
    assert url.endswith("/operator/rqlite/db/execute")
    assert "transaction" not in url
    assert options["json"] == [["VACUUM", {}]]


def test_rqlite_statement_error_is_raised():
    session = FakeSession({"results": [{"error": "no such table: owner_control"}]})
    client = RqliteClient(
        "https://api.example.com/operator/rqlite", "u", "p", session=session
    )

    with pytest.raises(RqliteError, match="no such table"):
        client.query_one("SELECT * FROM owner_control")

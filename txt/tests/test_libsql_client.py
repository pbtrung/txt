import base64

import txt.libsql_client as libsql_client_module
from txt.libsql_client import LibsqlClient, _cell_value, _to_arg


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _ok_result(rows=None):
    return {
        "type": "ok",
        "response": {"type": "execute", "result": {"cols": [], "rows": rows or []}},
    }


def test_to_arg_int():
    assert _to_arg(42) == {"type": "integer", "value": "42"}


def test_to_arg_text():
    assert _to_arg("hello") == {"type": "text", "value": "hello"}


def test_to_arg_bytes_is_base64_blob():
    data = bytes(range(10))
    arg = _to_arg(data)
    assert arg["type"] == "blob"
    assert base64.b64decode(arg["base64"]) == data


def test_cell_value_roundtrips_blob():
    data = bytes(range(20))
    cell = _to_arg(data)
    assert _cell_value(cell) == data


def test_cell_value_text_and_integer():
    assert _cell_value({"type": "text", "value": "hi"}) == "hi"
    assert _cell_value({"type": "integer", "value": "7"}) == 7


def test_cell_value_null():
    assert _cell_value({"type": "null"}) is None


def test_cell_value_decodes_unpadded_base64():
    # Turso's own HTTP API returns blob cells without trailing '=' padding
    # in practice, which Python's strict b64decode otherwise rejects with
    # "Incorrect padding" -- confirmed against real infra, not guessed.
    data = bytes(range(20))
    unpadded = base64.b64encode(data).decode().rstrip("=")
    assert _cell_value({"type": "blob", "base64": unpadded}) == data


def test_execute_sends_one_statement_and_close(monkeypatch):
    captured = {}

    def fake_post(url, headers, json):
        captured["body"] = json
        return FakeResponse({"results": [_ok_result()]})

    monkeypatch.setattr(libsql_client_module.requests, "post", fake_post)
    LibsqlClient("libsql://x.turso.io", "tok").execute("INSERT INTO t VALUES (?)", [1])

    assert [r["type"] for r in captured["body"]["requests"]] == ["execute", "close"]
    assert captured["body"]["requests"][0]["stmt"]["sql"] == "INSERT INTO t VALUES (?)"


def test_query_extracts_rows_from_execute_result(monkeypatch):
    rows = [[{"type": "integer", "value": "1"}, {"type": "text", "value": "hi"}]]

    def fake_post(url, headers, json):
        return FakeResponse({"results": [_ok_result(rows)]})

    monkeypatch.setattr(libsql_client_module.requests, "post", fake_post)
    result = LibsqlClient("libsql://x.turso.io", "tok").query("SELECT a, b FROM t")

    assert result == [[1, "hi"]]

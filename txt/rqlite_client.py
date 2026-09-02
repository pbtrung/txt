"""The predecessor design's rqlite HTTP client (docs and code on the
`master` branch), reintroduced only so `--migrate-rql` (migrate_rql.py)
can read the old owner_control row of a not-yet-migrated deployment.
Not used by anything targeting the current D1 design -- that's
d1_client.py."""

from collections.abc import Mapping, Sequence
from typing import Any

import requests


class RqliteError(RuntimeError):
    pass


class RqliteClient:
    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        *,
        session=requests,
    ):
        self.base_url = base_url.rstrip("/")
        self.auth = (username, password)
        self.session = session

    def query(self, sql: str, params: Mapping | None = None) -> list[dict]:
        result = self._request(
            "/db/query?level=strong&blob_array", [[sql, _encode(params or {})]]
        )[0]
        return _rows(result)

    def query_one(self, sql: str, params: Mapping | None = None) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Mapping | None = None) -> dict:
        return self._request("/db/execute?transaction", [[sql, _encode(params or {})]])[
            0
        ]

    def execute_batch(self, statements: Sequence[str]) -> list[dict]:
        body = [[sql, {}] for sql in statements]
        return self._request("/db/execute?transaction", body)

    def vacuum(self) -> dict:
        # SQLite forbids VACUUM inside a transaction, so this deliberately
        # omits the ?transaction query parameter execute()/execute_batch() use.
        return self._request("/db/execute", [["VACUUM", {}]])[0]

    def _request(self, path: str, statements: list) -> list[dict]:
        response = self.session.post(
            self.base_url + path,
            auth=self.auth,
            json=statements,
            timeout=(3.05, 10),
        )
        response.raise_for_status()
        results = response.json().get("results")
        if not isinstance(results, list):
            raise RqliteError("malformed rqlite response")
        for result in results:
            if result.get("error"):
                raise RqliteError(result["error"])
        return results


def _encode(value: Any) -> Any:
    if isinstance(value, bytes | bytearray):
        return list(value)
    if isinstance(value, Mapping):
        return {key: _encode(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str):
        return [_encode(item) for item in value]
    return value


def _rows(result: dict) -> list[dict]:
    columns = result.get("columns", [])
    values = result.get("values", [])
    return [dict(zip(columns, map(_decode, row), strict=True)) for row in values]


def _decode(value: Any) -> Any:
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        return bytes(value)
    return value

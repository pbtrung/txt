from collections.abc import Sequence
from typing import Any

import requests


class D1Error(RuntimeError):
    pass


class D1Client:
    """Cloudflare D1's HTTP query API (docs/data_model.md), used directly
    by this batch tool rather than the Worker's owner-facing ticket/proof
    protocol -- that protocol is for ephemeral browser sessions, not a
    long-running CLI carrying its own Cloudflare API token."""

    def __init__(
        self, account_id: str, database_id: str, api_token: str, *, session=requests
    ):
        self.base_url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{database_id}/query"
        )
        self.headers = {"Authorization": f"Bearer {api_token}"}
        self.session = session

    def query(self, sql: str, params: Sequence | None = None) -> list[dict]:
        return _rows(self._request(sql, params))

    def query_one(self, sql: str, params: Sequence | None = None) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Sequence | None = None) -> dict:
        return self._request(sql, params)

    def _request(self, sql: str, params: Sequence | None) -> dict:
        body = {"sql": sql, "params": _encode_params(params or [])}
        response = self.session.post(
            self.base_url, headers=self.headers, json=body, timeout=(3.05, 10)
        )
        response.raise_for_status()
        payload = response.json()
        if not payload.get("success"):
            raise D1Error(_error_message(payload))
        return _first_result_entry(payload)


def _first_result_entry(payload: dict) -> dict:
    result = payload.get("result")
    if not isinstance(result, list) or not result:
        raise D1Error("malformed D1 response")
    entry = result[0]
    if not entry.get("success", True):
        raise D1Error(_error_message(payload))
    return entry


def _error_message(payload: dict) -> str:
    messages = [str(error.get("message", "")) for error in payload.get("errors") or []]
    return "; ".join(m for m in messages if m) or "D1 request failed"


def _encode_params(params: Sequence) -> list[str]:
    return [_encode_one(value) for value in params]


def _encode_one(value: Any) -> str:
    """D1's HTTP API accepts only string parameters -- confirmed
    empirically against a real database, since it isn't documented
    anywhere. Binary values are hex-encoded here; pair every such
    parameter with SQL's unhex() at the call site (see owner_init.py).
    A BLOB column read back from a SELECT arrives as a plain JSON array
    of byte values instead, not hex -- see _decode_value below."""
    if isinstance(value, bytes | bytearray):
        return value.hex()
    if isinstance(value, str):
        return value
    raise TypeError(f"D1Client params must be str or bytes, got {type(value).__name__}")


def _rows(result: dict) -> list[dict]:
    return [_decode_row(row) for row in result.get("results") or []]


def _decode_row(row: dict) -> dict:
    return {key: _decode_value(value) for key, value in row.items()}


def _decode_value(value: Any) -> Any:
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        return bytes(value)
    return value

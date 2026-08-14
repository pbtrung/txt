import base64

import requests


def _to_arg(value) -> dict:
    if isinstance(value, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(value).decode()}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    return {"type": "text", "value": value}


def _cell_value(cell: dict):
    cell_type = cell.get("type")
    if cell_type == "blob":
        data = cell["base64"]
        return base64.b64decode(data + "=" * (-len(data) % 4))
    if cell_type == "integer":
        # Hrana encodes integers as decimal strings to preserve full 64-bit
        # precision across JSON (a plain JSON number would lose it) --
        # confirmed against real infra, not guessed.
        return int(cell["value"])
    return cell.get("value")


def _build_stmt(sql: str, args: list | None) -> dict:
    return {"sql": sql, "args": [_to_arg(a) for a in (args or [])]}


class LibsqlClient:
    def __init__(self, db_url: str, token: str):
        self.base = db_url.replace("libsql://", "https://", 1)
        self.token = token

    def execute(self, sql: str, args: list | None = None) -> dict:
        return self._pipeline([_build_stmt(sql, args)])[0]

    def query(self, sql: str, args: list | None = None) -> list:
        result = self.execute(sql, args)["response"]["result"]
        return [[_cell_value(cell) for cell in row] for row in result["rows"]]

    def batch(self, statements: list) -> None:
        """Run every (sql, args) pair as one pipeline HTTP call -- one round
        trip instead of one per statement, so a caller can bound how many
        statements land in a single request (Turso's Hrana endpoint can
        time out on an oversized batch).
        """
        self._pipeline([_build_stmt(sql, args) for sql, args in statements])

    def _pipeline(self, stmts: list) -> list:
        body = {
            "requests": [{"type": "execute", "stmt": s} for s in stmts]
            + [{"type": "close"}]
        }
        headers = {"Authorization": f"Bearer {self.token}"}
        resp = requests.post(f"{self.base}/v2/pipeline", headers=headers, json=body)
        resp.raise_for_status()
        return resp.json()["results"]

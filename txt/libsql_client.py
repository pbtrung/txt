import base64

import requests


def _to_arg(value) -> dict:
    if isinstance(value, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(value).decode()}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    return {"type": "text", "value": value}


def _cell_value(cell: dict):
    if cell.get("type") == "blob":
        return base64.b64decode(cell["base64"])
    return cell.get("value")


class LibsqlClient:
    def __init__(self, db_url: str, token: str):
        self.base = db_url.replace("libsql://", "https://", 1)
        self.token = token

    def execute(self, sql: str, args: list | None = None) -> dict:
        stmt = {"sql": sql, "args": [_to_arg(a) for a in (args or [])]}
        body = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
        headers = {"Authorization": f"Bearer {self.token}"}
        resp = requests.post(f"{self.base}/v2/pipeline", headers=headers, json=body)
        resp.raise_for_status()
        return resp.json()

    def query(self, sql: str, args: list | None = None) -> list:
        result = self.execute(sql, args)["results"][0]["response"]["result"]
        return [[_cell_value(cell) for cell in row] for row in result["rows"]]

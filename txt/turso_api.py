import requests

PLATFORM_API_BASE = "https://api.turso.tech/v1"


def extract_db_name(db_url: str, account_name: str) -> str:
    host = db_url.removeprefix("libsql://")
    return host.split(f"-{account_name}.", 1)[0]


class TursoClient:
    def __init__(self, org_token: str, org: str):
        self.org_token = org_token
        self.org = org

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.org_token}"}

    def create_database(self, name: str, group: str) -> dict:
        url = f"{PLATFORM_API_BASE}/organizations/{self.org}/databases"
        resp = requests.post(
            url, headers=self._headers(), json={"name": name, "group": group}
        )
        resp.raise_for_status()
        return resp.json()

    def mint_db_token(self, db_name: str, authorization: str = "full-access") -> str:
        url = f"{PLATFORM_API_BASE}/organizations/{self.org}/databases/{db_name}/auth/tokens"
        resp = requests.post(
            url,
            headers=self._headers(),
            params={"authorization": authorization},
            json={},
        )
        resp.raise_for_status()
        return resp.json()["jwt"]

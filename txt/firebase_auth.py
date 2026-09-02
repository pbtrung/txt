"""The predecessor design's Firebase sign-in (docs and code on the
`master` branch), reintroduced only so `--migrate-rql` (migrate_rql.py)
can authenticate against a not-yet-migrated deployment's rqlite
owner_control row, which is keyed by Firebase UID. The current design
has no Firebase dependency at all -- Cloudflare Access replaces it."""

import requests

SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"


class FirebaseAuth:
    def __init__(self, api_key: str):
        self.api_key = api_key

    def sign_in(self, email: str, password: str) -> str:
        body = {"email": email, "password": password, "returnSecureToken": True}
        resp = requests.post(
            SIGN_IN_URL,
            params={"key": self.api_key},
            json=body,
            timeout=(3.05, 10),
        )
        resp.raise_for_status()
        return resp.json()["localId"]

import txt.turso_api as turso_api_module
from txt.turso_api import TursoClient, extract_account_name


def test_extract_account_name_real_shape():
    url = "libsql://f11tumlpftfru50-pbtrung.aws-us-east-1.turso.io"
    assert extract_account_name(url, "f11tumlpftfru50") == "pbtrung"


def test_extract_account_name_generic():
    url = "libsql://abc123-myorg.aws-us-east-1.turso.io"
    assert extract_account_name(url, "abc123") == "myorg"


def test_mint_db_token_calls_platform_api(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"jwt": "minted-jwt"}

    def fake_post(url, headers, params, json):
        captured.update(url=url, headers=headers, params=params)
        return FakeResponse()

    monkeypatch.setattr(turso_api_module.requests, "post", fake_post)
    token = TursoClient("org-token", "myorg").mint_db_token("dbname")

    assert token == "minted-jwt"
    assert captured["url"].endswith("/organizations/myorg/databases/dbname/auth/tokens")
    assert captured["headers"] == {"Authorization": "Bearer org-token"}
    assert captured["params"] == {"authorization": "full-access"}

import json

import pytest

import txt.init_user as init_user_module
from txt.creds import load_creds
from txt.init_user import UserInitializer

CTL_URL = "libsql://ctl-x.aws-us-east-1.turso.io"


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class FakeFirebaseAuth:
    uids_by_email = {}

    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return FakeFirebaseAuth.uids_by_email[email]


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"

    def create_database(self, name, group):
        return {}


class FakeLibsqlClient:
    preset = {}
    instances = {}

    def __init__(self, url, token):
        self.url = url
        self.calls = []
        FakeLibsqlClient.instances[url] = self

    def execute(self, sql, args=None):
        self.calls.append(("execute", " ".join(sql.split()), args))
        return {}

    def query(self, sql, args=None):
        self.calls.append(("query", " ".join(sql.split()), args))
        for needle, rows in FakeLibsqlClient.preset.get(self.url, {}).items():
            if needle in sql:
                if isinstance(rows, dict):
                    return rows.get(args[0] if args else None, [])
                return rows
        return []


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(init_user_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(init_user_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(init_user_module, "LibsqlClient", FakeLibsqlClient)
    FakeFirebaseAuth.uids_by_email = {
        "admin@x.com": "admin-uid",
        "user@x.com": "new-user-uid",
    }
    FakeLibsqlClient.preset = {
        CTL_URL: {"SELECT type FROM users": {"admin-uid": [["admin"]]}}
    }
    FakeLibsqlClient.instances = {}
    yield


def _creds_path(tmp_path, name, email):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_url": CTL_URL,
        "turso_group": "g",
        "turso_org": "x",
        "firebase_email": email,
        "firebase_password": "pw",
        "firebase_api_key": "key",
    }
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return str(path)


@pytest.fixture
def admin_creds_path(tmp_path):
    return _creds_path(tmp_path, "admin_creds.json", "admin@x.com")


@pytest.fixture
def user_creds_path(tmp_path):
    return _creds_path(tmp_path, "user_creds.json", "user@x.com")


def test_registers_new_user_with_db_path_but_no_database(
    admin_creds_path, user_creds_path
):
    UserInitializer(
        load_creds(admin_creds_path), load_creds(user_creds_path), NullLogger()
    ).run()

    ctl = FakeLibsqlClient.instances[CTL_URL]
    insert = next(
        c for c in ctl.calls if c[0] == "execute" and "INSERT INTO users" in c[1]
    )
    uid, db_path, account_type, _created_at = insert[2]
    assert uid == "new-user-uid"
    assert account_type == "user"
    assert len(db_path) == 52


def test_second_run_does_not_reinsert(admin_creds_path, user_creds_path):
    FakeLibsqlClient.preset[CTL_URL]["SELECT id FROM users"] = {
        "new-user-uid": [["new-user-uid"]]
    }

    UserInitializer(
        load_creds(admin_creds_path), load_creds(user_creds_path), NullLogger()
    ).run()

    ctl = FakeLibsqlClient.instances[CTL_URL]
    inserts = [c for c in ctl.calls if c[0] == "execute" and "INSERT" in c[1]]
    assert inserts == []


def test_rejects_non_admin_admin_creds(tmp_path, user_creds_path):
    not_admin_creds_path = _creds_path(tmp_path, "not_admin.json", "someone@x.com")
    FakeFirebaseAuth.uids_by_email["someone@x.com"] = "not-an-admin-uid"

    with pytest.raises(ValueError, match="administrator"):
        UserInitializer(
            load_creds(not_admin_creds_path), load_creds(user_creds_path), NullLogger()
        ).run()

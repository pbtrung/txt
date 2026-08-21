import base64
import hashlib
import json
import secrets

import pytest

from txt.account_data import parse_storage_account, storage_binding
from txt.control_session import ControlFactories
from txt.creds import Creds, OwnerCreds, R2Config
from txt.crypto_blob import CryptoBlob
from txt.owner_init import OwnerInitializer
from txt.turso_migration import OwnerMigrator, TursoOwnerReader

OWNER_UID = "firebase-owner"


class CaptureLogger:
    def __init__(self):
        self.messages = []

    def verbose(self, message):
        self.messages.append(message)

    def info(self, message):
        self.messages.append(message)


class FakeFirebaseAuth:
    def __init__(self, _api_key):
        pass

    def sign_in(self, _email, _password):
        return OWNER_UID


class FakeRqlite:
    def __init__(self):
        self.owner = None
        self.inserts = 0
        self.updates = 0

    def query_one(self, _sql, _params=None):
        return self.owner

    def execute(self, sql, params=None):
        if sql.lstrip().startswith("INSERT"):
            self.owner = dict(params)
            self.inserts += 1
        else:
            self.owner.update(params)
            self.updates += 1
        return {}


class FakeSource:
    def __init__(self, payload, uid=OWNER_UID):
        self.payload, self.uid = payload, uid

    def read(self):
        return self.uid, self.payload


@pytest.fixture
def source_payload():
    handle = secrets.token_bytes(32)
    return {
        "user_handle": base64.b64encode(handle).decode(),
        "display_name": "Existing owner",
        "db_master_key": base64.b64encode(secrets.token_bytes(256)).decode(),
        "db_path": "0" * 52,
        "db_prefix": "1" * 52,
    }


@pytest.fixture
def owner_setup(tmp_path):
    creds = OwnerCreds(
        "operator",
        "secret",
        "https://api.example.com/operator/rqlite",
        "owner@example.com",
        "firebase-secret",
        "firebase-key",
        "Owner",
        R2Config("endpoint", "ro", "ro-secret", "rw", "rw-secret", "auto", "books"),
        "",
        "https://reader.example.com",
        "",
    )
    path = tmp_path / "rqlite.json"
    path.write_text(json.dumps(_owner_json(creds)))
    return creds, str(path)


def test_migrate_initializes_missing_owner_with_imported_payload(
    owner_setup, source_payload, engine
):
    creds, path = owner_setup
    rqlite, logger = FakeRqlite(), CaptureLogger()
    initializer = _initializer(creds, path, logger, rqlite, engine)
    migrator = _migrator(creds, path, logger, source_payload, initializer, engine)

    migrator.run()
    migrator.run()

    assert rqlite.inserts == 1
    assert rqlite.updates == 0
    assert _destination_payload(rqlite.owner, creds, engine) == source_payload


def test_migrate_existing_owner_preserves_new_keys(owner_setup, source_payload, engine):
    creds, path = owner_setup
    rqlite, logger = FakeRqlite(), CaptureLogger()
    initializer = _initializer(creds, path, logger, rqlite, engine)
    initializer.run()
    keys = _destination_keys(rqlite.owner)

    _migrator(creds, path, logger, source_payload, initializer, engine).run()

    assert rqlite.updates == 1
    assert _destination_keys(rqlite.owner) == keys
    assert _destination_payload(rqlite.owner, creds, engine) == source_payload


def test_migrate_dry_run_does_not_initialize_or_write_creds(
    owner_setup, source_payload, engine
):
    creds, path = owner_setup
    rqlite, logger = FakeRqlite(), CaptureLogger()
    initializer = _initializer(creds, path, logger, rqlite, engine)
    migrator = _migrator(
        creds, path, logger, source_payload, initializer, engine, dry_run=True
    )

    migrator.run()

    assert rqlite.inserts == 0
    assert json.loads(open(path).read())["user_root_key"] == ""
    assert any("Dry run" in message for message in logger.messages)


def test_migrate_rejects_different_firebase_uids(owner_setup, source_payload, engine):
    creds, path = owner_setup
    rqlite, logger = FakeRqlite(), CaptureLogger()
    initializer = _initializer(creds, path, logger, rqlite, engine)
    migrator = _migrator(
        creds, path, logger, source_payload, initializer, engine, source_uid="old-uid"
    )

    with pytest.raises(ValueError, match="Firebase UID mismatch"):
        migrator.run()
    assert rqlite.inserts == 0


def test_turso_reader_decrypts_and_validates_source(source_payload, engine):
    creds, row = _source_creds_and_row(source_payload, engine)

    reader = TursoOwnerReader(
        creds,
        CaptureLogger(),
        engine=engine,
        factories=_source_factories(row),
    )

    assert reader.read() == (OWNER_UID, source_payload)


def test_turso_reader_rejects_invalid_source_binding(source_payload, engine):
    creds, row = _source_creds_and_row(source_payload, engine)
    row[1] = bytes(64)
    reader = TursoOwnerReader(
        creds,
        CaptureLogger(),
        engine=engine,
        factories=_source_factories(row),
    )

    with pytest.raises(ValueError, match="path binding mismatch"):
        reader.read()


def _initializer(creds, path, logger, rqlite, engine):
    return OwnerInitializer(
        creds,
        path,
        logger,
        engine=engine,
        auth_factory=FakeFirebaseAuth,
        rqlite=rqlite,
    )


def _migrator(
    creds,
    path,
    logger,
    payload,
    initializer,
    engine,
    dry_run=False,
    source_uid=OWNER_UID,
):
    return OwnerMigrator(
        object(),
        creds,
        path,
        logger,
        dry_run,
        engine=engine,
        source=FakeSource(payload, source_uid),
        initializer=initializer,
    )


def _destination_payload(owner, creds, engine):
    blob = CryptoBlob(engine)
    root = base64.b64decode(creds.user_root_key)
    umk = blob.decrypt(owner["wrapped_umk"], root)
    return blob.decrypt_json(owner["encrypted_credentials"], umk)


def _destination_keys(owner):
    names = ("wrapped_umk", "kem_public_key", "sign_public_key")
    return tuple(owner[name] for name in names)


def _owner_json(creds):
    data = dict(vars(creds))
    data["r2_config"] = vars(creds.r2_config)
    return data


def _source_creds_and_row(payload, engine):
    root = secrets.token_bytes(256)
    creds = Creds(
        "token",
        "ctl",
        "libsql://ctl.example.com",
        "owner@example.com",
        "password",
        "api-key",
        user_root_key=base64.b64encode(root).decode(),
    )
    blob, umk = CryptoBlob(engine), secrets.token_bytes(128)
    handle = base64.b64decode(payload["user_handle"])
    row = [
        hashlib.sha256(handle).digest(),
        storage_binding(parse_storage_account(OWNER_UID, payload)),
        blob.encrypt(umk, root),
        blob.encrypt_json(payload, umk),
    ]
    return creds, row


def _source_factories(row):
    class FakeTurso:
        def __init__(self, _token, _account):
            pass

        def mint_db_token(self, _name):
            return "database-token"

    class FakeCtl:
        def __init__(self, _url, _token):
            pass

        def query(self, _sql, _args):
            return [row]

    return ControlFactories(FakeFirebaseAuth, FakeTurso, FakeCtl)

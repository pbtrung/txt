"""--clean-bucket: sweeps the whole shared R2 bucket for objects under a
top-level {db_prefix}/ segment that doesn't belong to any account known to
ctl.users (docs/data_model.md §6.5). Only ever reads the admin's own AA --
every other account's db_prefix already sits there, backed up by their own
--init-db run (docs/data_model.md §3.7) -- never another account's own AA
or BB.
"""

import base64

from .account_session import AccountSession
from .creds import Creds
from .crypto_blob import CryptoBlob
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .r2_client import R2Client
from .turso_api import extract_db_name


class BucketCleaner:
    def __init__(self, creds: Creds, dry_run: bool, logger: Logger):
        self.creds = creds
        self.dry_run = dry_run
        self.logger = logger
        self.session = AccountSession(creds, logger)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        self.r2 = None

    def run(self) -> None:
        self.logger.info(f"Starting bucket cleanup (dry_run={self.dry_run})...")
        self._validate_creds()
        self.r2 = R2Client(self.creds.r2_config)
        _uid, account_type, aa = self.session.connect()
        if account_type != "admin":
            raise ValueError(
                "--clean-bucket must be run with the administrator's own creds.json"
            )
        umk = self._require_umk(aa)
        accounts = self._read_ctl_users()
        verified = self._verify_cred_store(aa, umk)
        self._check_safety_gate(accounts, verified)
        self._sweep_unknown_prefixes(verified)
        self.logger.info("Bucket cleanup complete")

    def _validate_creds(self) -> None:
        if self.creds.r2_config is None:
            raise ValueError("creds.json is missing r2_config")
        if not self.creds.user_root_key:
            raise ValueError("creds.json has no user_root_key; run --init-db first")

    def _require_umk(self, aa: LibsqlClient) -> bytes:
        ikm = base64.b64decode(self.creds.user_root_key)
        umk = self.session.read_umk(aa, self.blob, ikm)
        if umk is None:
            raise ValueError("admin account has no key_store; run --init-db first")
        return umk

    def _read_ctl_users(self) -> list:
        self.logger.verbose("Reading ctl.users...")
        db_name = extract_db_name(self.creds.turso_ctl_db_url, self.creds.turso_org)
        ctl_token = self.session.turso.mint_db_token(db_name)
        ctl = LibsqlClient(self.creds.turso_ctl_db_url, ctl_token)
        rows = ctl.query("SELECT id, db_path, type FROM users")
        self.logger.verbose(f"{len(rows)} account(s) in ctl.users")
        return rows

    def _verify_cred_store(self, aa: LibsqlClient, umk: bytes) -> dict:
        rows = aa.query("SELECT user_id, content FROM cred_store")
        verified = {}
        for user_id, content in rows:
            try:
                payload = self.blob.decrypt_json(content, umk)
                if payload.get("user_id") != user_id:
                    raise ValueError("payload user_id does not match row's user_id")
                verified[user_id] = payload["db_prefix"]
            except Exception as exc:
                self.logger.verbose(f"cred_store row for {user_id} is unverifiable: {exc}")
        self.logger.verbose(f"{len(verified)}/{len(rows)} cred_store row(s) verified")
        return verified

    def _check_safety_gate(self, accounts: list, verified: dict) -> None:
        unverifiable = [uid for uid, _db_path, _type in accounts if uid not in verified]
        if not unverifiable:
            self.logger.verbose("every known account has a verified db_prefix")
            return
        message = (
            f"{len(unverifiable)} account(s) have no verifiable db_prefix: "
            f"{', '.join(unverifiable)}"
        )
        if self.dry_run:
            self.logger.info(f"WARNING: {message} (dry-run: would refuse in real mode)")
            return
        raise ValueError(f"{message}; refusing to delete anything")

    def _sweep_unknown_prefixes(self, verified: dict) -> None:
        known = set(verified.values())
        listed = self.r2.list_common_prefixes()
        self.logger.verbose(f"{len(listed)} top-level prefix(es) in the bucket")
        unknown = [p for p in listed if p.rstrip("/") not in known]
        if not unknown:
            self.logger.info("No unknown prefixes found.")
            return
        for prefix in unknown:
            self._handle_unknown_prefix(prefix)

    def _handle_unknown_prefix(self, prefix: str) -> None:
        keys = self.r2.list_keys(prefix)
        if self.dry_run:
            self.logger.info(f"[dry-run] would delete {len(keys)} object(s) under {prefix}")
            return
        self.r2.delete_keys(keys)
        self.logger.info(f"Deleted {len(keys)} object(s) under {prefix}")

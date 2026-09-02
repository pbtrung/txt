"""--ingest: uploads each new *.epub in a directory as an encrypted R2
object and writes its documents/key_store rows directly to D1
(txt/d1_client.py) -- not through the Worker's ticket/proof-gated
endpoints, which are designed for ephemeral browser sessions rather than
a long-running batch tool with its own Cloudflare API token
(docs/data_model.md §2.1).

Recovery: a local JSON checkpoint (`{db_prefix}.ingest-checkpoint.json`
in --local-db-dir) records `{filename: document_id}` for every file whose
D1 rows have been written, saved immediately after that insert and
before the catalog rewrite. A run killed between the two steps resumes
from the checkpoint without re-uploading or re-inserting; the catalog
itself is also checked against by filename first, so a lost checkpoint
still can't silently skip files whose catalog entry already exists.
"""

import base64
import json
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

import brotli

from .account_data import parse_owner_account
from .creds import OwnerCreds
from .crypto_blob import CryptoBlob
from .d1_client import D1Client
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .opf import catalog_fields, find_opf_sidecar, parse_opf_metadata
from .owner_init import OwnerInitializer
from .r2_client import R2Client
from .random_token import to_base32_crockford

CATALOG_QUERY = "SELECT key_id, catalog_blob FROM catalog WHERE singleton = 1"


@dataclass
class CatalogState:
    existing_key_id: int | None
    row_key: bytes
    catalog_key: bytes
    catalog_path: str
    entries: list[dict]
    covered_ids: set = field(default_factory=set)

    def __post_init__(self):
        self.covered_ids = {entry["document_id"] for entry in self.entries}


class TxtIngester:
    def __init__(
        self,
        src_dir: Path,
        local_db_dir: Path,
        creds: OwnerCreds,
        creds_path: str,
        logger: Logger,
        *,
        engine: LeancryptoEngine | None = None,
        d1: D1Client | None = None,
        r2: R2Client | None = None,
    ):
        self.src_dir, self.local_db_dir, self.logger = src_dir, local_db_dir, logger
        self._set_services(creds, creds_path, logger, engine, d1, r2)

    def _set_services(self, creds, creds_path, logger, engine, d1, r2) -> None:
        self.engine = engine or LeancryptoEngine()
        self.owner = OwnerInitializer(
            creds, creds_path, logger, engine=self.engine, d1=d1
        )
        self.r2 = r2 or R2Client(creds.r2_config)
        self.blob = CryptoBlob(self.engine)
        self.d1: D1Client = self.owner.d1
        self.umk = self.account = self.checkpoint_path = None
        self.checkpoint = {}

    def run(self) -> None:
        self._prepare_run()
        self._ingest_all()
        self.logger.info(f"Ingest complete: db_prefix={self.account.db_prefix}")

    def _prepare_run(self) -> None:
        self.umk, payload = self.owner.load_current_owner()
        self.account = parse_owner_account(payload)
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint_path = (
            self.local_db_dir / f"{self.account.db_prefix}.ingest-checkpoint.json"
        )
        self.checkpoint = _load_checkpoint(self.checkpoint_path)
        self.logger.info(
            f"db_prefix={self.account.db_prefix} local={self.local_db_dir}"
        )

    def _ingest_all(self) -> None:
        state = self._load_catalog_state()
        to_process = self._files_to_process(state)
        total = len(list(self.src_dir.glob("*.epub")))
        changed = self._process_files(to_process, total, state)
        if changed:
            self._publish_catalog(state)
        else:
            self.logger.verbose(
                "Catalog already reflects every document; no upload needed."
            )

    def _files_to_process(self, state: CatalogState) -> list[Path]:
        existing_names = {entry["catalog"]["name"] for entry in state.entries}
        all_paths = sorted(self.src_dir.glob("*.epub"))
        to_process = [p for p in all_paths if p.name not in existing_names]
        self.logger.info(
            f"{len(to_process)} file(s) to ingest, "
            f"{len(all_paths) - len(to_process)} already done, {len(all_paths)} total"
        )
        return to_process

    def _process_files(
        self, to_process: list[Path], total: int, state: CatalogState
    ) -> bool:
        changed = False
        processed = total - len(to_process)
        for epub_path in to_process:
            processed += 1
            document_id = self._ensure_document(epub_path, processed, total)
            if document_id not in state.covered_ids:
                self._add_catalog_entry(state, document_id, epub_path)
                changed = True
        return changed

    def _add_catalog_entry(
        self, state: CatalogState, document_id: int, epub_path: Path
    ) -> None:
        state.entries.append(
            {"document_id": document_id, "catalog": self._catalog_payload(epub_path)}
        )
        state.covered_ids.add(document_id)

    def _ensure_document(self, epub_path: Path, processed: int, total: int) -> int:
        name = epub_path.name
        if name in self.checkpoint:
            self.logger.verbose(
                f"[{processed}/{total}] {name}: already in D1, "
                "reconciling catalog only."
            )
            return self.checkpoint[name]
        document_id = self._insert_new_document(epub_path, processed, total)
        self.checkpoint[name] = document_id
        _save_checkpoint(self.checkpoint_path, self.checkpoint)
        return document_id

    def _insert_new_document(self, epub_path: Path, processed: int, total: int) -> int:
        data = epub_path.read_bytes()
        content_key = secrets.token_bytes(128)
        path = to_base32_crockford(secrets.token_bytes(32))
        object_key = self._upload_content(path, data, content_key)
        document_id = self._insert_document_and_keys(path, content_key)
        self.logger.info(
            f"[{processed}/{total}] {epub_path.name} ({len(data)} byte(s)) -> "
            f"{object_key} document_id={document_id}"
        )
        return document_id

    def _upload_content(self, path: str, data: bytes, content_key: bytes) -> str:
        object_key = f"{self.account.db_prefix}/documents/{path}"
        self.r2.put_object(
            object_key, self.blob.encrypt(data, content_key), if_none_match=True
        )
        return object_key

    def _insert_document_and_keys(self, path: str, content_key: bytes) -> int:
        content_row_key = secrets.token_bytes(128)
        access_row_key = secrets.token_bytes(128)
        content_key_id, access_key_id = self._insert_row_keys(
            content_row_key, access_row_key
        )
        content_blob = self._content_blob(path, content_key, content_row_key)
        access_blob = self.blob.encrypt_json(
            {"last_accessed": 0, "last_cfi": None}, access_row_key
        )
        return self._insert_document_row_or_cleanup(
            content_key_id, content_blob, access_key_id, access_blob
        )

    def _insert_row_keys(
        self, content_row_key: bytes, access_row_key: bytes
    ) -> tuple[int, int]:
        content_key_id = self._insert_key(
            "content_key", self.blob.encrypt(content_row_key, self.umk)
        )
        access_key_id = self._insert_key(
            "access_key", self.blob.encrypt(access_row_key, self.umk)
        )
        return content_key_id, access_key_id

    def _content_blob(
        self, path: str, content_key: bytes, content_row_key: bytes
    ) -> bytes:
        return self.blob.encrypt_json(
            {"content_key": base64.b64encode(content_key).decode(), "path": path},
            content_row_key,
        )

    def _insert_document_row_or_cleanup(
        self,
        content_key_id: int,
        content_blob: bytes,
        access_key_id: int,
        access_blob: bytes,
    ) -> int:
        try:
            return self._insert_document_row(
                content_key_id, content_blob, access_key_id, access_blob
            )
        except Exception:
            self._delete_key(content_key_id)
            self._delete_key(access_key_id)
            raise

    def _insert_key(self, purpose: str, wrapped_key: bytes) -> int:
        result = self.d1.execute(
            f"INSERT INTO key_store (purpose, wrapped_key, created_at) "
            f"VALUES (?, unhex(?), {_now_ms()})",
            [purpose, wrapped_key],
        )
        return result["meta"]["last_row_id"]

    def _insert_document_row(
        self,
        content_key_id: int,
        content_blob: bytes,
        access_key_id: int,
        access_blob: bytes,
    ) -> int:
        result = self.d1.execute(
            "INSERT INTO documents "
            "(created_at, content_key_id, content_blob, access_key_id, access_blob) "
            f"VALUES ({_now_ms()}, {content_key_id}, unhex(?), "
            f"{access_key_id}, unhex(?))",
            [content_blob, access_blob],
        )
        return result["meta"]["last_row_id"]

    def _delete_key(self, key_id: int) -> None:
        self.d1.execute(f"DELETE FROM key_store WHERE id = {key_id}")

    def _catalog_payload(self, epub_path: Path) -> dict:
        """{name, title, authors, subjects, publisher} -- just what the
        Library screen needs to search/browse (docs/data_model.md §2.1).
        Full metadata for display comes from the EPUB's own internal OPF
        instead, parsed client-side when a book is actually opened.
        """
        opf_path = find_opf_sidecar(epub_path)
        opf_metadata = parse_opf_metadata(opf_path) if opf_path is not None else {}
        return {"name": epub_path.name, **catalog_fields(opf_metadata, epub_path.name)}

    def _load_catalog_state(self) -> CatalogState:
        row = self.d1.query_one(CATALOG_QUERY)
        if row is None:
            return CatalogState(
                None,
                secrets.token_bytes(128),
                secrets.token_bytes(128),
                _new_path(),
                [],
            )
        return self._load_existing_catalog_state(row)

    def _load_existing_catalog_state(self, row: dict) -> CatalogState:
        row_key = self._unwrap_key(row["key_id"])
        pointer = self.blob.decrypt_json(row["catalog_blob"], row_key)
        catalog_key = base64.b64decode(pointer["catalog_key"])
        catalog_path = pointer["catalog_path"]
        entries = self._download_catalog_entries(catalog_path, catalog_key)
        return CatalogState(row["key_id"], row_key, catalog_key, catalog_path, entries)

    def _download_catalog_entries(
        self, catalog_path: str, catalog_key: bytes
    ) -> list[dict]:
        object_key = f"{self.account.db_prefix}/catalog/{catalog_path}"
        data = self.r2.get_object(object_key)
        if data is None:
            return []
        return json.loads(brotli.decompress(self.blob.decrypt(data, catalog_key)))

    def _unwrap_key(self, key_id: int) -> bytes:
        row = self.d1.query_one(
            f"SELECT wrapped_key FROM key_store WHERE id = {key_id}"
        )
        return self.blob.decrypt(row["wrapped_key"], self.umk)

    def _publish_catalog(self, state: CatalogState) -> None:
        self._upload_catalog_object(state)
        catalog_blob = self._catalog_pointer_blob(state)
        if state.existing_key_id is None:
            self._create_catalog_row(state, catalog_blob)
        else:
            self._update_catalog_row(state.existing_key_id, catalog_blob)

    def _upload_catalog_object(self, state: CatalogState) -> None:
        object_key = f"{self.account.db_prefix}/catalog/{state.catalog_path}"
        data = self.blob.encrypt(
            brotli.compress(json.dumps(state.entries).encode()), state.catalog_key
        )
        self.logger.verbose(
            f"Uploading catalog ({len(state.entries)} entries) to {object_key}..."
        )
        self.r2.put_object(object_key, data)

    def _catalog_pointer_blob(self, state: CatalogState) -> bytes:
        return self.blob.encrypt_json(
            {
                "catalog_key": base64.b64encode(state.catalog_key).decode(),
                "catalog_path": state.catalog_path,
            },
            state.row_key,
        )

    def _create_catalog_row(self, state: CatalogState, catalog_blob: bytes) -> None:
        key_id = self._insert_key(
            "catalog_key", self.blob.encrypt(state.row_key, self.umk)
        )
        self.d1.execute(
            "INSERT INTO catalog (singleton, key_id, catalog_blob, updated_at) "
            f"VALUES (1, {key_id}, unhex(?), {_now_ms()})",
            [catalog_blob],
        )

    def _update_catalog_row(self, key_id: int, catalog_blob: bytes) -> None:
        self.d1.execute(
            f"UPDATE catalog SET catalog_blob = unhex(?), updated_at = {_now_ms()} "
            f"WHERE singleton = 1 AND key_id = {key_id}",
            [catalog_blob],
        )


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_path() -> str:
    return to_base32_crockford(secrets.token_bytes(32))


def _load_checkpoint(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_checkpoint(path: Path, checkpoint: dict[str, int]) -> None:
    path.write_text(json.dumps(checkpoint, indent=2) + "\n")

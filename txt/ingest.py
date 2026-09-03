"""--ingest: uploads each new *.epub in a directory as an encrypted R2
object and writes its documents/key_store rows directly to D1
(txt/d1_client.py) -- not through the Worker's ticket/proof-gated
endpoints, which are designed for ephemeral browser sessions rather than
a long-running batch tool with its own Cloudflare API token
(docs/data_model.md §2.1). The D1/R2 write and catalog-merge machinery
itself lives in catalog_writer.py.

Recovery: a local JSON checkpoint (`{db_prefix}.ingest-checkpoint.json`
in --local-db-dir) records `{filename: document_id}` for every file whose
D1 rows have been written, saved immediately after that insert and
before the catalog rewrite. A run killed between the two steps resumes
from the checkpoint without re-uploading or re-inserting; the catalog
itself is also checked against by filename first, so a lost checkpoint
still can't silently skip files whose catalog entry already exists.
"""

import json
import secrets
from pathlib import Path

from .account_data import parse_owner_account
from .catalog_writer import CatalogWriter, DocumentStore
from .creds import OwnerCreds
from .crypto_blob import CryptoBlob
from .d1_client import D1Client
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .opf import catalog_fields, find_opf_sidecar, parse_opf_metadata
from .owner_init import OwnerInitializer
from .r2_client import R2Client
from .random_token import to_base32_crockford


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
        self.store: DocumentStore | None = None
        self.catalog: CatalogWriter | None = None
        self.checkpoint = {}

    def run(self) -> None:
        self._prepare_run()
        self._ingest_all()
        self.logger.info(f"Ingest complete: db_prefix={self.account.db_prefix}")

    def _prepare_run(self) -> None:
        self.umk, payload = self.owner.load_current_owner()
        self.account = parse_owner_account(payload)
        self.store = DocumentStore(
            self.d1, self.r2, self.blob, self.umk, self.account.db_prefix
        )
        self.catalog = CatalogWriter(self.store)
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint_path = (
            self.local_db_dir / f"{self.account.db_prefix}.ingest-checkpoint.json"
        )
        self.checkpoint = _load_checkpoint(self.checkpoint_path)
        self.logger.info(
            f"db_prefix={self.account.db_prefix} local={self.local_db_dir}"
        )

    def _ingest_all(self) -> None:
        state = self.catalog.load_state()
        to_process = self._files_to_process(state)
        total = len(list(self.src_dir.glob("*.epub")))
        changed = self._process_files(to_process, total, state)
        if changed:
            self.logger.verbose(f"Uploading catalog ({len(state.entries)} entries)...")
            self.catalog.publish(state)
        else:
            self.logger.verbose(
                "Catalog already reflects every document; no upload needed."
            )

    def _files_to_process(self, state) -> list[Path]:
        existing_names = {entry["catalog"]["name"] for entry in state.entries}
        all_paths = sorted(self.src_dir.glob("*.epub"))
        to_process = [p for p in all_paths if p.name not in existing_names]
        self.logger.info(
            f"{len(to_process)} file(s) to ingest, "
            f"{len(all_paths) - len(to_process)} already done, {len(all_paths)} total"
        )
        return to_process

    def _process_files(self, to_process: list[Path], total: int, state) -> bool:
        changed = False
        processed = total - len(to_process)
        for epub_path in to_process:
            processed += 1
            document_id = self._ensure_document(epub_path, processed, total)
            payload = self._catalog_payload(epub_path)
            if self.catalog.add_entry(state, document_id, payload):
                changed = True
        return changed

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
        object_key = self.store.upload_content(path, data, content_key)
        document_id = self.store.insert_document(content_key, path)
        self.logger.info(
            f"[{processed}/{total}] {epub_path.name} ({len(data)} byte(s)) -> "
            f"{object_key} document_id={document_id}"
        )
        return document_id

    def _catalog_payload(self, epub_path: Path) -> dict:
        """{name, title, authors, subjects, publisher} -- just what the
        Library screen needs to search/browse (docs/data_model.md §2.1).
        Full metadata for display comes from the EPUB's own internal OPF
        instead, parsed client-side when a book is actually opened.
        """
        opf_path = find_opf_sidecar(epub_path)
        opf_metadata = parse_opf_metadata(opf_path) if opf_path is not None else {}
        return {"name": epub_path.name, **catalog_fields(opf_metadata, epub_path.name)}


def _load_checkpoint(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_checkpoint(path: Path, checkpoint: dict[str, int]) -> None:
    path.write_text(json.dumps(checkpoint, indent=2) + "\n")

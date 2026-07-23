# txt

A fully client-side-encrypted text vault.

- **Backend (Turso, libSQL/SQLite-compatible cloud)** holds all structured data — accounts, wrapped keys, R2 object paths, sharing grants, bookmarks, and read-position — but only ever sees ciphertext, or values that are already public (public keys, KEM ciphertexts/salts).
- **Document content** lives in R2 object storage, not Turso; Turso only holds the (wrapped) R2 path.
- **All encryption, decryption, and key (un)wrapping happens client-side** (or in admin tooling), never in the database.

## Data model & key hierarchy

- `users` — looked up by a keyed-HMAC username hash, authenticated by a PBKDF2 password check.
- `umk` — each user's master key, wrapped under a per-user root key held outside Turso in per-user JSON config.
- `key_store` — an `lc_kyber_1024_x448` composite keypair used to receive documents shared by other users.
- `txt` / `txt_parts` — a user's documents, chunked into parts; each part stores a wrapped R2 object path rather than inline content.
- `txt_key` — wrapped under the owner's `umk`; each document has its own.
- `txt_shares` — sharing a document with another user re-wraps that same `txt_key` under the recipient's public key, instead of revealing the owner's `umk`.

## CLI (`txt.py`)

### Ingest / download / delete

- **`--txt-ingest <dir>`** ingests `.txt` files (case-insensitive) from a directory into the admin's own account: `txt/textproc.py` cleans and splits each file, `txt/ingest.py` generates each part's random R2 path and uploads it via `txt/r2.py`. `txt.py --init` remains the one-time step that provisions the admin account this ingests into.
- **`--txt-download <dir>`** reverses this: `txt/download.py` fetches and decrypts every part of each of the admin's txt, concatenating them back into one file per document. If a txt's `txt_metadata.content` entry has a `metadata` key (i.e. it was ingested from a `<name>.epub.txt` with an OPF sidecar), it also writes that metadata back out as `<name>.opf.json` (`{"metadata": {...}}`, via `txt/opf.py`'s `metadata_sidecar_name`) alongside the reconstructed file.
- **`--txt-delete`** removes every one of the admin's txt entirely: `txt/delete.py` deletes each txt's R2 parts, then its `txt`/`txt_parts`/`txt_shares`/`part_count`/`txt_access`/`bookmarks` rows (explicitly, since nothing enables `PRAGMA foreign_keys`), and clears `txt_metadata.content`.
- **`--txt-delete-id <txt_id>`** does the same for a single txt_id, leaving the rest of the admin's txt untouched: `TxtDeleter.delete_one` deletes that txt's R2 parts and the same `txt`/`txt_parts`/`txt_shares`/`part_count`/`txt_access`/`bookmarks` rows, then scrubs just that `txt_id`'s entry out of `txt_metadata.content` (rather than clearing it outright, since other txt's entries must survive).

### Shared internals

- `txt/ingest.py`'s `TxtIngester`, `txt/download.py`'s `TxtDownloader`, and `txt/delete.py`'s `TxtDeleter` all subclass `txt/owner.py`'s `TxtOwner` for the account/key lookups they share (resolving `creds.username` to a `user_id`, unwrapping `umk`, listing `txt_ids`, unwrapping a `txt_key`, decrypting a txt's part paths), and operate on parts concurrently (via `asyncio` + a shared thread pool), capped at `constants.R2_NUM_THREADS` parallel R2 requests.
- `txt/r2.py`'s `R2Client.put_async`/`get_async`/`delete_async` retry with exponential backoff before giving up; `--txt-ingest`/`--txt-download` clean up (deleting uploaded R2 parts, or the partial output file) and raise a clear error if retries are exhausted.
- `TxtIngester.add_file` uploads every part of a file *before* touching the DB at all (`txt_key` lives only in memory until then), then writes the `txt` row, its `txt_parts`/`part_count` rows, and its `txt_metadata` entry as one uninterrupted synchronous burst (`_persist_txt`) — Turso's Hrana streams expire after ~10s of inactivity and can't be recovered once expired, so the DB connection must never sit idle across something as slow as R2 uploads with retries. If that burst fails partway (or even if `rollback()` itself fails, since the same broken stream can make it fail too — see `_safe_rollback`), every part already uploaded for that file is deleted from R2 before the error propagates.
- `--txt-ingest` also skips filenames already recorded in `txt_metadata.content` (`TxtIngester._files_to_ingest`), so re-running it on the same directory doesn't create duplicate `txt` rows.
- **OPF metadata sidecar:** for a `<name>.epub.txt` file (case-insensitive), ingest looks for a sibling `<name>.opf` (also case-insensitive; `txt/opf.py`'s `find_opf_sidecar`) — a Calibre metadata sidecar — and if found, parses its `<metadata>` element (`parse_opf_metadata`: `dc:*` elements keyed by local tag name, Calibre's `<meta name=".." content="..">` keyed by `name`, repeated tags collapsed into a list) into `txt_metadata.content`'s entry as `{"name": ..., "metadata": {...}}`. Plain `.txt` files (or an `.epub.txt` with no matching `.opf`) just get `{"name": ...}` as before.

### Bucket housekeeping

`txt.py --purge-bucket` and `txt.py --txt-clean-bucket` (`txt/bucket.py`'s `BucketPurger` and `TxtBucketCleaner`) are bucket-level housekeeping rather than per-txt operations — both list the bucket via `R2Client.list_keys_async` and require the same destructive-action confirmation prompt (skippable with `-y`/`--yes`) as `--txt-delete`:

- **`--purge-bucket`** deletes every object in the R2 bucket with no DB awareness at all.
- **`--txt-clean-bucket`** (a `TxtOwner` subclass) deletes only the R2 objects that aren't referenced by any of the account's `txt_parts`.

## Web UI (`ui/`)

`ui/` is a second, browser-based client implementing [docs/ui.md](docs/ui.md)'s design (React + TypeScript + Vite + Vitest, Bootstrap CSS/Icons): Unlock, Library, and Reader screens over the same vault, reading (and lightly writing: read-position, bookmarks) it directly from the browser rather than through `txt.py`.

- `ui/src/crypto/` ports `txt/constants.py` + `txt/crypto.py` 1:1 (`leancryptoLoader.ts` binds the prebuilt `ui/leancrypto/leancrypto.js`/`.wasm`; `blob.ts`/`kem.ts` mirror `Blob`/`Kem` exactly, cross-checked against fixtures generated by the real `txt/crypto.py`).
- `ui/src/data/` ports `txt/creds.py`/`txt/owner.py`/`txt/download.py`/`txt/r2.py` (read-only R2 access via `aws4fetch`, Turso via `@libsql/client`'s browser-safe `/web` build).
- The one thing this config doesn't carry that `admin_creds.json`/`user_cred_template.json` do is `r2_config` — the UI fetches and decrypts that from Turso's `r2_config` table with the account's `umk` instead (`ui/src/data/owner.ts`'s `fetchR2Config`), same wrapping pattern as `key_store.priv_key`.
- A `VaultContext` (`ui/src/state/VaultContext.tsx`) holds the unlocked session in memory only, never persisted, so a reload always lands back on Unlock.
- `ui/src/log.ts`'s `verbose()` (on by default, `?verbose=0` to disable — see the root [README.md](README.md#verbose-logging)) logs `unlock()`'s steps and, via `ui/src/data/db.ts`'s wrapped `Client`, every screen's `db.execute()` calls.
- `ui/src/localIndex/` is the verifier bundled into `creds/local_index.html` by `ui/scripts/build-integrity.mjs` (`npm run build -- --admin-creds <path>`) — a separate, never-deployed file opened directly (e.g. `file://`) instead of the CDN URL, so its verifier can't be tampered away the way one shipped inside the CDN-served bundle itself could be. `verify.ts` SLH-DSA-verifies (`@noble/post-quantum`) a `manifest.json` of every `ui/dist/` file's SHA-512 before trusting anything, `render.ts` mounts the app straight from those already-verified bytes (never re-fetching `index.html`/the entry JS/CSS), and `progress.ts` drives the spinner/step list shown while that happens — see the root [README.md](README.md#locally-verified-boot-local_indexhtml) for the full threat model and its known limitations.

See the root [README.md](README.md#web-ui) for how to run it.

## Documentation

- [docs/data_model.md](docs/data_model.md) — the Turso schema, the key hierarchy (root key → umk → txt_key/txt_metadata_key/key_store keypair → content), and design notes/open questions.
  Read this before touching anything related to the schema, key hierarchy, or sharing. Per-user isolation is real cryptographic envelope encryption — `umk` wraps everything an owner holds — with one intentional exception: `txt_shares`, which grants another user access to a specific document via asymmetric (KEM) wrapping rather than by revealing the owner's `umk`.
- [docs/crypto.md](docs/crypto.md) — encryption mechanics: the AEAD/KDF/KEM primitives, the blob wire format, and the Encrypt/Decrypt/Encapsulate/Decapsulate procedures, used identically for every blob type.
  Read this before touching anything related to the blob format or key derivation — it defines the Encrypt/Decrypt/Encapsulate/Decapsulate procedures used uniformly across every encrypted column in the schema.
- [docs/credentials.md](docs/credentials.md) — the two credential roles (`AdminCreds`/`UserCreds`), what each is allowed to hold in `r2_config`, and the Turso token scoping each role is expected to use.
  Read this before touching `txt/creds.py` or anything that loads a credential JSON file — the admin and user roles are validated to carry deliberately different R2 key shapes.
- [docs/ui.md](docs/ui.md) — the visual design (Bootstrap-based) for the local web reader in `ui/` — Unlock, Library, and Reader screens.

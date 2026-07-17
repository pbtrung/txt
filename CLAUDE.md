# txt

A fully client-side-encrypted text vault. A CLI (`txt.py`, package `txt/`) and a browser-based web UI (`ui/`) both connect directly to a Turso (libSQL) cloud database over HTTPS, sharing the same full-access token — no local file, no application server. The CLI ingests `.txt` files, encrypts them, and writes; the web UI lets users browse, search, read, and bookmark files, with all encryption/decryption happening client-side. Turso only ever sees ciphertext.

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, ingest/read pipelines, multi-user model
- [docs/tech_stack.md](docs/tech_stack.md) — languages, libraries, credentials shape, and two known `libsql` client bugs to guard against
- [docs/data_model.md](docs/data_model.md) — full SQLite schema and design notes/open questions
- [docs/crypto.md](docs/crypto.md) — encryption scheme (AEAD, KDF, MAC, key hierarchy), used identically for every blob type
- [docs/security.md](docs/security.md) — threat model, what `user_id`/sharing does and does not guarantee cryptographically, and the risks of a single full-access Turso token

Read `docs/data_model.md` and `docs/security.md` before touching anything related to the `users`/`user_id` multi-user feature — per-user isolation is real cryptographic envelope encryption (see `crypto.md`'s Key Hierarchy), not just an application-layer filter, but it only covers file *content* and filenames, not database-level write access (a single shared Turso token can touch any row).

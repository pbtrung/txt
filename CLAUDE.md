# txt

A fully client-side-encrypted text vault. A CLI (`txt.py`, package `txt/`) ingests `.txt` files into a local SQLite database; a browser-based web UI (`ui/`) loads that same database file and lets users browse, search, and read files, with all decryption happening client-side. No server component, no network dependency at rest.

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, ingest/read pipelines, multi-user model
- [docs/tech_stack.md](docs/tech_stack.md) — languages, libraries, and the open question on persisting browser writes
- [docs/data_model.md](docs/data_model.md) — full SQLite schema and design notes/open questions
- [docs/crypto.md](docs/crypto.md) — encryption scheme (AEAD, KDF, MAC), used identically for every blob type
- [docs/security.md](docs/security.md) — threat model, and what the `user_id` multi-user filter does and does not guarantee

Read `docs/data_model.md` and `docs/security.md` before touching anything related to the `users`/`user_id` multi-user feature — the access control it provides is application-layer only, not cryptographic.

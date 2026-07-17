# Architecture

## Overview

`txt` is a fully client-side-encrypted text vault. Two independent components share one local SQLite database file:

- **CLI (`txt.py`, package `txt/`)** — local-only; ingests `.txt` files from disk, encrypts them, and writes them into a local SQLite `.db` file via stdlib `sqlite3`. Also handles download/export back to plaintext `.txt` files.
- **Web UI (`ui/`)** — a browser app that loads the same `.db` file directly (via `sql.js`, see [tech_stack.md](tech_stack.md)) and lets the user browse, search, and read files, with all decryption happening client-side.

There is no server component and no network dependency anywhere in this app. See [tech_stack.md](tech_stack.md) for the open question on how browser-side writes (bookmarks, read position) get persisted back to that file.

## Components

```
txt.py                  entry point (thin, delegates to txt/ package)
txt/
  cli.py                click command definitions
  store.py              VaultStore: local sqlite3 connection, ingest/admin operations
  downloader.py         Downloader: decrypt + export to plaintext .txt files
  crypto.py             Crypto: all cryptographic operations (see crypto.md)
  schema.py             DDL (see data_model.md)
  utils.py              text preprocessing, file splitting, credentials loading
  constants.py          shared numeric constants
  leancrypto.py         ctypes bindings to the leancrypto shared library

ui/
  src/                  React app; sql.js + leancrypto-wasm for client-side DB access and decryption
```

## Ingest pipeline (CLI)

```
for each .txt file under --src, ingesting as a given user:
  1. Look up filename against that user's decrypted txt_metadata row (see
     data_model.md) to check for an existing entry.
  2. No match  → generate a fresh txt_key, wrap it under this user's umk,
     INSERT a new txt row (id, user_id, txt_key), add name to this user's
     txt_metadata entry.
     Match, no --force → skip.
     Match + --force   → reuse txt_id and its existing txt_key, DELETE existing parts.
  3. Preprocess (normalise paragraph spacing).
  4. Split into ~200 KB parts at paragraph boundaries.
  5. Per part: brotli-compress, AEAD-encrypt (random salt per part, keyed off
     this file's txt_key), store in txt_parts.
  6. Upsert part_count.
  7. Re-encrypt and write back this user's updated txt_metadata row once per
     ingest run (not per file — see data_model.md).
  8. Commit.
```

Filenames are resolved through a single decrypted index rather than a per-row scan; see [data_model.md](data_model.md) and [crypto.md](crypto.md).

## Read pipeline (Web UI)

```
1. User selects the local .db file.
2. sql.js loads it into an in-memory SQLite instance.
3. User logs in as a specific user; the app unwraps that user's `umk` from
   `umk_store` (see crypto.md's Key Hierarchy).
4. UI decrypts the logged-in user's own txt_metadata row to get their
   id → name map (client-side) — inherently scoped to their own files.
5. Opening a file unwraps its txt_key using the logged-in user's umk, then
   streams its txt_parts rows, decrypting one part at a time with that
   txt_key (same AEAD scheme as ingest).
6. Bookmarks / txt_access reads and writes go through the same in-memory
   sql.js database; see tech_stack.md for how writes get persisted back to disk.
```

## Multi-user model

A `users` table, an `umk_store` table (each user's wrapped user-master-key), and a `user_id` + `txt_key` column on `txt` provide real per-user key isolation — not just visibility filtering. Every file belongs to exactly one user; there is no shared/public file. `txt_metadata` (filenames) is isolated the same way, one row per user. See [crypto.md](crypto.md)'s Key Hierarchy section for how `root_master_key → umk → txt_key` wraps content and filenames, and [security.md](security.md) for what this does and does not protect against.

# Architecture

## Overview

`txt` is a fully client-side-encrypted text vault. One `.db` file, one writer, one read-only distribution point:

- **CLI (`txt.py`, package `txt/`)** — the only writer. Local-only; ingests `.txt` files from disk, encrypts them, and writes them into a local SQLite `.db` file via stdlib `sqlite3`. Also handles download/export back to plaintext `.txt` files, and sharing (below).
- **Sync to Cloudflare R2** — after a local write, the `.db` file is pushed wholesale to R2 (S3-compatible object storage). This is a distribution step, not a live write path — see [tech_stack.md](tech_stack.md) for whether it's CLI-driven or an external tool.
- **Web UI (`ui/`)** — a browser app that reads the R2-hosted `.db` directly over paged HTTP range requests (SQLite-WASM + a custom HTTP VFS, no whole-file download, no application server — see [tech_stack.md](tech_stack.md)) and lets the user browse, search, and read files, with all decryption happening client-side.

There's no application server and no custom backend logic, but there **is** a network dependency now: the web UI's read path goes over HTTP to R2. It cannot write back through that path at all — R2 doesn't support partial/byte-range writes, so the read-only-ness is structural, not a policy choice. See [tech_stack.md](tech_stack.md) for the open question this raises for browser-side writes (bookmarks, read position).

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
  src/                  React app; SQLite-WASM + HTTP VFS (paged reads from R2) + leancrypto-wasm
                        for client-side DB access and decryption
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
1. UI opens the R2-hosted .db via the HTTP VFS — no download of the whole
   file, just the SQLite header/schema pages needed to start querying.
2. User logs in as a specific user; the app unwraps that user's `umk` from
   `umk_store` (fetches just that row's page(s) over Range requests; see
   crypto.md's Key Hierarchy).
3. UI decrypts the logged-in user's own txt_metadata row to get their
   id → name map (client-side) — inherently scoped to their own files.
4. Opening a file: if it's in the logged-in user's own txt_metadata as an
   owned file, unwrap its txt_key via txt.txt_key; if it's there as a
   shared file, unwrap via that user's txt_shares row instead (see
   crypto.md's Key Hierarchy). Either way, stream its txt_parts rows —
   each fetched over Range requests as needed — decrypting one part at a
   time with that txt_key (same AEAD scheme as ingest).
5. Bookmarks / txt_access reads are the same paged fetch. Writes cannot go
   through this path at all (R2 is read-only over this VFS); see
   tech_stack.md's open question on where browser-side writes go instead.
```

## Share pipeline (CLI)

```
txt.py --share <file> --to <user> --creds creds.json     # grant
txt.py --unshare <file> --from <user> --creds creds.json # revoke
```

```
Grant:
  1. Unwrap the owner's umk (ikm=root_master_key), then the file's txt_key
     (ikm=owner's umk).
  2. Unwrap the recipient's umk (ikm=root_master_key).
  3. Re-wrap the same txt_key under the recipient's umk (fresh salt);
     UPSERT into txt_shares (txt_id, user_id=recipient, txt_key).
  4. Read the filename from the owner's txt_metadata; decrypt the
     recipient's txt_metadata, add the same txt_id → name entry, re-encrypt
     and write it back.

Revoke:
  1. DELETE FROM txt_shares WHERE txt_id=? AND user_id=?.
  2. Remove that txt_id from the recipient's txt_metadata; re-encrypt and
     write it back.
  3. DELETE that user's txt_access/bookmarks rows for this txt_id — they
     can no longer decrypt the content those rows reference.
```

Both operations require `root_master_key` (same trust tier as `--src`/`--download`) — sharing is CLI-mediated, not something a browser session can do with only its own `umk`. See [crypto.md](crypto.md)'s Sharing section and [security.md](security.md) for why, and for what revocation does and does not guarantee (no forward secrecy over already-retrieved plaintext).

Like ingest, a grant/revoke only takes effect for readers once the updated local `.db` is synced to R2 (see [tech_stack.md](tech_stack.md)) — there's a window between a local grant/revoke and it being visible to the web UI.

## Multi-user model

A `users` table, an `umk_store` table (each user's wrapped user-master-key), and a `user_id` + `txt_key` column on `txt` provide real per-user key isolation — not just visibility filtering. Every file has exactly one owner; `txt_shares` grants read access to others without making them co-owners or exposing the owner's `umk`. `txt_metadata` (filenames) is isolated the same way, one row per user, covering both owned and shared-to-them files. See [crypto.md](crypto.md)'s Key Hierarchy section for how `root_master_key → umk → txt_key`/`txt_metadata_key` wraps content and filenames, and [security.md](security.md) for what this does and does not protect against.

# Tech Stack

## CLI (`txt.py` / `txt/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Language | Python 3.11+ | |
| DB driver | `libsql` (Turso's Python client), connecting directly to the cloud database | No local file, no intermediate storage tier — every CLI operation (ingest, share/unshare, download) is a live query/transaction against Turso over HTTPS. |
| Compression | `brotli` | Unchanged from the previous design; applied before encryption. |
| Crypto | `leancrypto`, via ctypes, loaded as a system shared library | Unchanged. |
| CLI parsing | `click` | Unchanged. |

### Two known `libsql` client failure modes — guard against both from the start

This exact stack (Turso + the Python `libsql` client) caused two real bugs earlier in this project, both in `downloader.py`, both worth building in defenses for from day one rather than rediscovering them:

1. **Hrana stream expiry.** A single connection/stream reused across a long-running operation (e.g. `--download` over many files) can be invalidated server-side mid-run; every subsequent query on that same stream then fails identically (`stream not found`) for the rest of the run. Fix: catch this specific error, reconnect (fresh connection = fresh stream), and retry the failed operation once before giving up.
2. **`Cursor` isn't iterable.** The installed `libsql` client's `Cursor` doesn't implement `__iter__`/`__next__` — only `fetchone`/`fetchmany`/`fetchall`. Iterating a cursor directly (`for row in cursor`) raises `'builtins.Cursor' object is not iterable`. Fix: use an explicit `fetchone()` loop (or `fetchall()` where streaming isn't needed) instead of bare iteration.

## Web UI (`ui/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Framework | React + Bootstrap | Unchanged. |
| Build tool | Vite | Unchanged. |
| DB access | Turso's JS client (`@libsql/client`), connecting directly from the browser | No application server, no local file. The browser holds the same full-access Turso token as the CLI (see crypto.md's Credentials File) and issues queries/transactions directly over HTTPS — reads and writes both, including bookmarks and `txt_access`. |
| Crypto | `leancrypto` compiled to WebAssembly | Unchanged — decryption still happens entirely client-side. |

Bookmarks and `txt_access` writes are no longer an open question: they're just another query against the same connection everything else uses, the same way the original pre-redesign app worked.

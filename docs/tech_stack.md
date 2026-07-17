# Tech Stack

## CLI (`txt.py` / `txt/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Language | Python 3.11+ | |
| DB driver | Python stdlib `sqlite3` | The only writer in the whole system. All ingest/share/admin operations write directly to a local `.db` file — no network, no remote connection from the CLI itself. |
| Compression | `brotli` | Unchanged from the previous design; applied before encryption. |
| Crypto | `leancrypto`, via ctypes, loaded as a system shared library | Unchanged. |
| CLI parsing | `click` | Unchanged. |

### Sync to Cloudflare R2 (distribution, not writes)

After a local write (ingest, share/unshare, etc.), the local `.db` file is pushed to Cloudflare R2 (S3-compatible object storage) so the web UI has something to read. This is a **replace-the-object sync**, not a live write path — R2 doesn't support in-place partial writes, so every push uploads the current `.db` file wholesale.

Open item: whether this sync is a built-in CLI flag (e.g. `txt.py --push`, adding an S3 client dependency) or an external step the operator runs with a standard S3-compatible tool (`rclone`, `aws s3 cp --endpoint-url <r2-endpoint>`, etc.) against R2's S3-compatible API, keeping `txt.py` free of a cloud SDK dependency. Leaning toward the external-tool route to keep the CLI's dependency footprint as-is, but flagging it as a real choice.

## Web UI (`ui/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Framework | React + Bootstrap | Unchanged. |
| Build tool | Vite | Unchanged. |
| DB access | SQLite compiled to WASM + a custom HTTP VFS (paged range-request reads), modeled on `sql.js-httpvfs`/`httpvfs.cpp` | No whole-file download and no application server. The VFS translates SQLite page reads into HTTP `Range` GET requests against the `.db` object on R2, fetching only the pages a query actually touches. Inherently **read-only** — R2 doesn't support partial/byte-range writes, so there's no equivalent paged-write path. |
| Crypto | `leancrypto` compiled to WebAssembly | Unchanged — decryption still happens entirely client-side, page-by-page as fetched. |

### Open question: where do browser-side writes go?

Bookmarks and `txt_access` (read position) used to be written by the browser directly into the loaded `.db`. That no longer works at all: the R2-hosted copy is read-only by construction (paged HTTP reads, no write path), not just read-only by policy. Three options, and this needs a decision before `bookmarks`/`txt_access` are implemented against this transport:

1. **Client-side only** (`localStorage`/IndexedDB in the browser) — never synced back to the canonical `.db`. Simplest, but per-device/per-browser: bookmarks don't follow you to another device, and are lost if browser storage is cleared.
2. **A separate writable side-channel** — e.g. a small Cloudflare Worker in front of a KV/D1 store, written to directly by the browser, decoupled from the read-only `.db` blob. The CLI would periodically pull these down and merge them into the canonical local `.db` on the next sync-up. This reintroduces real server-side logic (a Worker), which is more than "just object storage" — a meaningful scope increase over the rest of this design.
3. **Drop browser-side bookmarks/`txt_access` for now** — treat them as CLI/local-only, same as ingest. Simplest to reason about, but is a real regression from the original interactive line-bookmarking feature.

Leaning toward (1) as the lowest-lift starting point, with (2) as the real fix if cross-device bookmarks matter — flagging rather than deciding, since (2) changes the "no server component" framing elsewhere in these docs.

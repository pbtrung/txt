# Tech Stack

## CLI (`txt.py` / `txt/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Language | Python 3.11+ | |
| DB driver | Python stdlib `sqlite3` | `txt.py` is local-only — no network, no remote connection of any kind. |
| Compression | `brotli` | Unchanged from the previous design; applied before encryption. |
| Crypto | `leancrypto`, via ctypes, loaded as a system shared library | Unchanged. |
| CLI parsing | `click` | Unchanged. |

## Web UI (`ui/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Framework | React + Bootstrap | Unchanged. |
| Build tool | Vite | Unchanged. |
| DB access | `sql.js` (SQLite compiled to WebAssembly) | No server. The user picks the local `.db` file (file input or drag-and-drop); `sql.js` loads it into an in-memory database and all queries run client-side. |
| Crypto | `leancrypto` compiled to WebAssembly | Unchanged — decryption still happens entirely client-side. |

### Open question: persisting writes from the browser

`sql.js` operates on an in-memory copy of the loaded file — it does not write back to disk by itself. With a local file there are two options, and this needs a decision before `bookmarks`/`txt_access` writes are implemented:

1. **File System Access API** (`showSaveFilePicker`/file handle with write permission) — the browser can write the modified bytes back to the same file on disk. Chromium-based browsers only (not Firefox/Safari).
2. **Export flow** — the UI offers a "save changes" download of the updated `.db` file, which the user manually replaces on disk. Works in any browser, worse UX.

This document assumes option 1 as the default target; flag if that's not acceptable given your target browsers.

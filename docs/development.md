# Development

## Python tests

```sh
pip install pytest pytest-cov
pytest --cov=txt --cov-report=term-missing
```

Unit tests live in `tests/`; `tests/test_crypto.py` covers `txt/crypto.py`'s blob format,
AEAD, KDF, and KEM primitives against the real `leancrypto` bindings (no mocking).

## Web UI tests

```sh
cd ui
npm test
```

Vitest, run against `ui/src/**/*.test.ts(x)`.

## Verbose logging

On by default. Load the app with `?verbose=0` in the URL to turn it off for that page
load (`ui/src/log.ts`; toggle mid-session with `setVerbose()` instead of reloading if you
don't want to lose an in-progress session — it isn't persisted across reloads, same as
`VaultContext`'s own session state). It logs `unlock()`'s steps
(`ui/src/state/VaultContext.tsx` — parsing the config, resolving the user id, checking
the password, unwrapping `umk`, loading metadata/access/bookmarks) and every
`db.execute()` call, from any screen, logs its SQL/args and either its row count or its
error (`ui/src/data/db.ts`).

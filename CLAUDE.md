# txt

A fully client-side-encrypted text vault. An admin CLI (`cli/`, Node/TypeScript) and a browser-based web UI (`ui/`) both connect directly to InstantDB over HTTPS, with entry content stored in Cloudflare R2 via InstantDB's built-in Storage feature — no local file, no bespoke application server. Users authenticate with Firebase Auth. The admin CLI (role `admin`) is the only way to CRUD users and ingest/delete entries on their behalf, using an InstantDB admin token that bypasses all permission rules; regular users (role `user`) never touch the CLI at all — they browse, search, read, bookmark, and track read-position on their own entries in the web UI, constrained by InstantDB's `instant.perms.ts` owner-only rules, with all encryption/decryption happening client-side. InstantDB and R2 only ever see ciphertext.

## Documentation

- [docs/data_model.md](docs/data_model.md) — the `instant.schema.ts`/`instant.perms.ts` schema, the key hierarchy, and design notes/open questions
- [docs/crypto.md](docs/crypto.md) — encryption mechanics (AEAD primitives, blob wire format, key derivation), used identically for every blob type

Read `docs/data_model.md` before touching anything related to the `$users`/roles/multi-user model — per-user isolation is both real cryptographic envelope encryption (see `data_model.md`'s Key Hierarchy) *and* a real database-enforced boundary (`instant.perms.ts`'s `isOwner` rules). There is no cross-user sharing — every `txt` row links to exactly one `umkStore`/owner, `has: 'one'` all the way down.

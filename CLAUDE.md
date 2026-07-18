# txt

A fully client-side-encrypted text vault. An admin CLI (`cli/`, Node/TypeScript) and a browser-based web UI (`ui/`) both connect directly to InstantDB over HTTPS, with entry content stored in Cloudflare R2 via InstantDB's built-in Storage feature — no local file, no bespoke application server. Users authenticate with Firebase Auth. The admin CLI (role `admin`) is the only way to CRUD users and ingest/delete entries on their behalf, using an InstantDB admin token that bypasses all permission rules; regular users (role `user`) never touch the CLI at all — they browse, search, read, bookmark, and track read-position on their own entries in the web UI, constrained by InstantDB's `instant.perms.ts` owner-only rules, with all encryption/decryption happening client-side. InstantDB and R2 only ever see ciphertext.

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, ingest/read/provisioning pipelines, admin/user role model
- [docs/tech_stack.md](docs/tech_stack.md) — languages, libraries, config shape, and InstantDB-specific things to guard against
- [docs/data_model.md](docs/data_model.md) — the live `instant.schema.ts`/`instant.perms.ts`, plus additive entities (bookmarks, filename index) and design notes/open questions
- [docs/crypto.md](docs/crypto.md) — encryption scheme (AEAD, KDF, key hierarchy), used identically for every blob type
- [docs/security.md](docs/security.md) — threat model, what per-user isolation does and does not guarantee cryptographically *and* at the database-permission layer, and the risks of the admin CLI's config

Read `docs/data_model.md` and `docs/security.md` before touching anything related to the `$users`/roles/multi-user model — per-user isolation is now both real cryptographic envelope encryption (see `crypto.md`'s Key Hierarchy) *and* a real database-enforced boundary (`instant.perms.ts`'s `isOwner` rules), a genuine improvement over the old single-shared-Turso-token design where only the crypto layer provided any isolation at all. There is no cross-user sharing in this redesign — see `security.md` for why that was dropped rather than carried over.

# txt

A fully client-side-encrypted text vault. Backend: Turso (libSQL/SQLite-compatible cloud) holds all structured data — accounts, wrapped keys, R2 object paths, sharing grants, bookmarks, and read-position — but only ever sees ciphertext, or values that are already public (public keys, KEM ciphertexts/salts). Document content itself lives in R2 object storage, not Turso; Turso only holds the (wrapped) R2 path. All encryption, decryption, and key (un)wrapping happens client-side (or in admin tooling), never in the database.

Each user has an account (`users`, looked up by a keyed-HMAC username hash, authenticated by a PBKDF2 password check), a master key (`umk`, wrapped under a per-user root key held outside Turso in per-user JSON config), and an `lc_kyber_1024_x448` composite keypair (`key_store`) used to receive documents shared by other users. A user's documents (`txt`) are chunked into parts (`txt_parts`), each part storing a wrapped R2 object path rather than inline content; each document has its own `txt_key` wrapped under the owner's `umk`. A document can also be shared with another user (`txt_shares`), which re-wraps that same `txt_key` under the recipient's public key instead of revealing the owner's `umk`.

## Documentation

- [docs/data_model.md](docs/data_model.md) — the Turso schema, the key hierarchy (root key → umk → txt_key/txt_metadata_key/key_store keypair → content), and design notes/open questions
- [docs/crypto.md](docs/crypto.md) — encryption mechanics: the AEAD/KDF/KEM primitives, the blob wire format, and the Encrypt/Decrypt/Encapsulate/Decapsulate procedures, used identically for every blob type

Read `docs/data_model.md` before touching anything related to the schema, key hierarchy, or sharing. Per-user isolation is real cryptographic envelope encryption — `umk` wraps everything an owner holds — with one intentional exception: `txt_shares`, which grants another user access to a specific document via asymmetric (KEM) wrapping rather than by revealing the owner's `umk`. Read `docs/crypto.md` before touching anything related to the blob format or key derivation — it defines the Encrypt/Decrypt/Encapsulate/Decapsulate procedures used uniformly across every encrypted column in the schema.

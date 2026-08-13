# Key Hierarchy

How the encryption keys for the entities in [data_model.md](data_model.md) nest, and which field on which row holds each one. See [crypto.md](crypto.md) for the AEAD/KDF/KEM primitives (Encrypt/Decrypt, Encapsulate/Decapsulate) this hierarchy is built from.

```
user_root_key
    (per-account config secret, >=256 random bytes, base64; not
    stored in InstantDB)
    |  IKM for HKDF, wraps/unwraps --
    v
$users.umk
    (128 random bytes, generated once per account)
    |  used directly as IKM for HKDF, wraps/unwraps --
    +--> keyStore.keyStoreKey   (per user, 128 random bytes)
    |        |  used directly as IKM --
    |        +--> keyStore.privKey
    |                 (lc_kyber_1024_x448 composite private key, 3224
    |                 raw bytes -- pubKey stored raw/public, not wrapped)
    |
    +--> credStore.credStoreKey   (128 random bytes; fresh per credStore
    |        |                     row, wrapped by that row owner's umk;
    |        |                     credStore.forUser only identifies the
    |        |                     account the row is about)
    |        |  used directly as IKM --
    |        +--> credStore.content   (credential JSON, per row)
    |
    +--> txt.txtKey            (per document, 128 random bytes, owner-only)
    |        |  used directly as IKM --
    |        +--> txt.prefix           (this document's own R2 prefix)
    |        +--> txtMetadata.content  (full name/opf metadata, no intermediate key)
    |        +--> txtMetadata.catalog  (listing projection, no intermediate key)
    |        |
    |        +--> txtParts.txtPartKey   (per part, 128 random bytes)
    |                 |  used directly as IKM --
    |                 +--> txtParts.path        (wraps the R2 raw_key)
    |                 +--> txtParts R2 object body (independent second wrap)
    |
    +--> txtAccess.txtAccessKey   (per user, 128 random bytes)
    |        |  used directly as IKM --
    |        +--> txtAccess.content   (read position, keyed by txt_id)
    |
    +--> txtBookmarks.txtBookmarkKey   (per user, 128 random bytes)
             |  used directly as IKM --
             +--> txtBookmarks.content   (bookmarks, keyed by txt_id)

txt.prefixHash is not another key-hierarchy edge: it is the plaintext Base64
encoding of the SHA-256 digest of the decrypted txt.prefix, stored on the
same txt row so the credential Worker can bind {txtId, prefix} before minting
a read-only credential. The 32-random-byte prefix remains encrypted above.
```

Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly.

## Sharing a document: an independent, parallel chain

**Not yet implemented** — `sharedTxt`/`sharedTxtParts` don't exist in `instant.schema.ts` yet; today's code shares by KEM-rewrapping `txt.txtKey` itself once per recipient (`txtShares.kemCt`/`txtShares.txtKey`), so the recipient reads the admin's own `txt`/`txtParts` directly. The chain below is the design to build against.

Sharing a document does not rewrap `txt.txtKey` for the recipient at all — it mints an entirely independent root key for the share, rooted its own way, and copies the document's content under it:

```
sharedTxt's own root txtKey   (per (document, recipient) share, 128 random
    bytes -- independent of the source document's own txt.txtKey; never
    itself stored -- only its two wraps below are)
    |
    |  wrapped TWO independent, purely symmetric ways, both recovering
    |  the same plaintext -- sharing uses neither keyStore's KEM keypair
    |  nor Encapsulate/Decapsulate at all --
    |
    +-- wrapped directly under fromUser's (the admin's) own umk
    |       --> sharedTxt.adminTxtKey
    |       (lets admin-side tooling, e.g. the orphan sweep, recover this
    |       share's whole chain on demand, without re-deriving anything
    |       about the recipient)
    |
    +-- wrapped directly under owner's (the recipient's) own umk
    |       --> sharedTxt.userTxtKey
    |       (the admin can produce this wrap because creating a share is
    |       already an admin action with admin-level reach: the admin
    |       decrypts its own admin-owned recovery credStore row for that
    |       recipient to recover their user_root_key, then uses it to
    |       decrypt the recipient's own $users.umk -- the same
    |       user_root_key -> umk unwrap at the top of this file, just run
    |       by the admin instead of the recipient's own client. A
    |       recipient's own later read unwraps userTxtKey exactly like
    |       any owner unwraps txt.txtKey: under their own umk, directly)
    |
    v  either unwrap yields the same plaintext bytes, used directly as IKM --
    +--> sharedTxt.prefix              (this share's own, independent R2 prefix)
    +--> sharedTxtMetadata.content     (copy of txtMetadata.content, re-encrypted at share time)
    +--> sharedTxtMetadata.catalog     (copy of txtMetadata.catalog, re-encrypted at share time)
    |
    +--> sharedTxtParts.txtPartKey   (per part, 128 random bytes)
             |  used directly as IKM --
             +--> sharedTxtParts.path        (wraps the R2 raw_key)
             +--> sharedTxtParts R2 object body (independent second wrap)
```

`sharedTxt.adminTxtKey` and `sharedTxt.userTxtKey` wrap the identical plaintext bytes under two different accounts' `umk` — the same pattern `credStore.credStoreKey` already uses to let a user's own row and the admin's recovery copy of it exist independently (see this file's Design notes below), just applied to a single key instead of two. Nothing below this share's root `txtKey` cares which of the two unwraps produced it; both sides derive identical downstream keys. Revoking a share needs no parallel "pending" chain the way a same-key-for-every-recipient design would: deleting the `sharedTxt` row deletes the only copy of this whole chain's root key, for this recipient, without touching the source document or any other recipient's own independent share.

## Context columns

**Not yet implemented.** No `<field>Context` column exists in `instant.schema.ts`, and `txt/crypto.ts`'s `blobEncrypt`/`blobDecrypt` take no `context` parameter — every wrapped column today authenticates only against `magic`/`version`/`salt` (crypto.md's Additional Data). This section describes the intended design; the column list below is not yet backed by schema or code.

Every column wrapped by this design's Encrypt procedure has a matching `<field>Context` column: 32 random bytes, base64, generated once alongside the column it protects and stored in plaintext next to it. Its value is supplied as `context` (crypto.md's Additional Data / Encrypt / Decrypt) whenever that specific column is encrypted or decrypted — never derived from the blob, never reused across two different columns. Because it lives on the row being read rather than inside the ciphertext being moved, a blob copied from one column or row into another — the same IKM commonly protects several distinct columns throughout this hierarchy, `umk`'s five children above being the clearest example — carries the wrong context with it and fails to decrypt, rather than silently succeeding against the wrong value.

`<field>Context` is not itself sensitive — it needs to be unique per column, not secret — so storing it in plaintext costs nothing security-relevant. It is not a key-hierarchy edge (nothing is derived from it beyond being fed into HKDF's `info`/AD alongside the real IKM), and it is a different mechanism from `txt.prefixHash` below despite both being public: `prefixHash` binds one specific value to a document for the credential Worker to check against a client-supplied prefix, while `<field>Context` binds every wrapped column to itself so its ciphertext can never be substituted for another column's.

| Column                        | Wrapped under                | Context column                       |
| ----------------------------- | ---------------------------- | ------------------------------------ |
| `$users.umk`                  | `user_root_key`              | `$users.umkContext`                  |
| `keyStore.keyStoreKey`        | owner's `umk`                | `keyStore.keyStoreKeyContext`        |
| `keyStore.privKey`            | `keyStoreKey`                | `keyStore.privKeyContext`            |
| `credStore.credStoreKey`      | owner's `umk`                | `credStore.credStoreKeyContext`      |
| `credStore.content`           | that row's `credStoreKey`    | `credStore.contentContext`           |
| `txt.txtKey`                  | owner's `umk`                | `txt.txtKeyContext`                  |
| `txt.prefix`                  | that document's `txtKey`     | `txt.prefixContext`                  |
| `txtMetadata.content`         | that document's `txtKey`     | `txtMetadata.contentContext`         |
| `txtMetadata.catalog`         | that document's `txtKey`     | `txtMetadata.catalogContext`         |
| `txtParts.txtPartKey`         | that document's `txtKey`     | `txtParts.txtPartKeyContext`         |
| `txtParts.path`               | that part's own `txtPartKey` | `txtParts.pathContext`               |
| `txtParts` R2 object body     | that part's own `txtPartKey` | `txtParts.bodyContext`               |
| `sharedTxt.adminTxtKey`       | `fromUser`'s `umk`           | `sharedTxt.adminTxtKeyContext`       |
| `sharedTxt.userTxtKey`        | `owner`'s `umk`              | `sharedTxt.userTxtKeyContext`        |
| `sharedTxt.prefix`            | this share's own root key    | `sharedTxt.prefixContext`            |
| `sharedTxtMetadata.content`   | this share's own root key    | `sharedTxtMetadata.contentContext`   |
| `sharedTxtMetadata.catalog`   | this share's own root key    | `sharedTxtMetadata.catalogContext`   |
| `sharedTxtParts.txtPartKey`   | this share's own root key    | `sharedTxtParts.txtPartKeyContext`   |
| `sharedTxtParts.path`         | that part's own `txtPartKey` | `sharedTxtParts.pathContext`         |
| `sharedTxtParts` R2 object body | that part's own `txtPartKey` | `sharedTxtParts.bodyContext`       |
| `txtAccess.txtAccessKey`      | owner's `umk`                | `txtAccess.txtAccessKeyContext`      |
| `txtAccess.content`           | that row's `txtAccessKey`    | `txtAccess.contentContext`           |
| `txtBookmarks.txtBookmarkKey` | owner's `umk`                | `txtBookmarks.txtBookmarkKeyContext` |
| `txtBookmarks.content`        | that row's `txtBookmarkKey`  | `txtBookmarks.contentContext`        |

`txtParts.bodyContext`/`sharedTxtParts.bodyContext` have no corresponding InstantDB "body" field to sit next to — the value each protects is the R2 object itself, not an InstantDB column — so each lives on its own `txtParts`/`sharedTxtParts` row alongside `txtPartKey`/`path`/their own context columns, the same place `txtPartKey` already lives despite also protecting something stored only in R2.

Most of these columns exist for uniformity rather than necessity. `txtKey`, `txtPartKey`, and `credStoreKey` are each already unique to one document, one part, or one specific row, so a fixed per-field label would already prevent confusion between the different columns each one wraps, with no randomness required. The two spots where a random value is actually load-bearing are `credStore.credStoreKey` and `txt.txtKey`/`sharedTxt.adminTxtKey`/`sharedTxt.userTxtKey`: an owner's single `umk` wraps many `credStore` rows and many `txt`/`sharedTxt` rows at once, and nothing else about those rows tells one apart from another. Applying the same `<field>Context` column uniformly everywhere trades a small amount of storage for not having to re-derive, and keep correct as the schema evolves, exactly which columns need it.

## Design notes

- **Every part's own `txtPartKey`, layered under the document's `txtKey`, bounds a compromised part to that one part.** `txt.prefix` (document-level) is wrapped directly under `txtKey`; a part's `path` and its R2 object body are both wrapped under that row's own `txtPartKey` instead — two independent applications of `txtPartKey`, one protecting the R2 _address_, one the part's _content_. Compromising a single part's `txtPartKey` never exposes another part of the same document, nor the document-level `prefix`, both of which stay under `txtKey` alone. Compromising R2 list/read access alone (without any `txtPartKey`) yields neither the mapping from part to object nor the ability to decrypt any object it did manage to guess.
- **Every `credStore` row has its own intermediate key.** A user's own row and the admin's recovery copy for that user can intentionally describe the same account, but their plaintext payloads serve different purposes and their ciphertexts are independent because each row has a different random `credStoreKey`, wrapped under a different owner's `umk`.

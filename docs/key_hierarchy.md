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

txt.txtKey, in parallel, is also wrapped a second way -- not under
umk -- once per share recipient:

    admin Encapsulates (crypto.md) against recipient's keyStore.pubKey
        |
        v
    txtShares.{kemCt, txtKey}
        (txtKey here is the same bytes as txt.txtKey, wrapped via
        HKDF-SHA3-512(IKM=ss, blob salt) -> 128-byte OKM instead of umk;
        kemCt stores only the KEM ciphertext)
        |
        |  recipient Decapsulates using their own keyStore.privKey
        v
    (recipient now holds txt.txtKey, unwrapped, without ever
    learning the admin's umk)
```

Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly. `txtShares.txtKey` is the one value in this hierarchy wrapped via Encapsulate/Decapsulate (asymmetric) instead of a plain Encrypt/Decrypt under a key both sides already hold.

A document mid `txt.ts --revoke-share` (docs/protocols.md's Revoking a share) carries a second, parallel key chain, rooted the same way as the first:

```
txt.pendingTxtKey   (staged replacement txtKey, wrapped under owner's umk)
    |  used directly as IKM --
    +--> txt.pendingPrefix              (replacement prefix)
    +--> txtParts.pendingTxtPartKey     (per part, replacement txtPartKey)
             |  used directly as IKM --
             +--> txtParts.pendingPath  (replacement path)
```

`txt.staleR2Prefix` is not part of either chain: like `prefixHash`, it is wrapped directly under `owner`'s `umk`, never under any `txtKey` (current or pending) -- it exists only so a crashed-and-resumed rekey can still find and delete the retired prefix's R2 objects once cutover finishes, regardless of which `txtKey` happens to be live at the time. Nothing under `txt.pending*` gets its own share rewrap: only once cutover flips `txtKey`/`prefix`/`prefixHash` live does the existing Encapsulate/Decapsulate chain above apply to the new `txtKey`, for every recipient still holding a live `txtShares` row at that moment -- necessarily excluding the just-revoked recipient, whose row is already gone by the time reveal runs.

## Context columns

**Not yet implemented.** No `<field>Context` column exists in `instant.schema.ts`, and `txt/crypto.ts`'s `blobEncrypt`/`blobDecrypt` take no `context` parameter — every wrapped column today authenticates only against `magic`/`version`/`salt` (crypto.md's Additional Data). This section describes the intended design; the column list below is not yet backed by schema or code.

Every column wrapped by this design's Encrypt procedure has a matching `<field>Context` column: 32 random bytes, base64, generated once alongside the column it protects and stored in plaintext next to it. Its value is supplied as `context` (crypto.md's Additional Data / Encrypt / Decrypt) whenever that specific column is encrypted or decrypted — never derived from the blob, never reused across two different columns. Because it lives on the row being read rather than inside the ciphertext being moved, a blob copied from one column or row into another — the same IKM commonly protects several distinct columns throughout this hierarchy, `umk`'s five children above being the clearest example — carries the wrong context with it and fails to decrypt, rather than silently succeeding against the wrong value.

`<field>Context` is not itself sensitive — it needs to be unique per column, not secret — so storing it in plaintext costs nothing security-relevant. It is not a key-hierarchy edge (nothing is derived from it beyond being fed into HKDF's `info`/AD alongside the real IKM), and it is a different mechanism from `txt.prefixHash` below despite both being public: `prefixHash` binds one specific value to a document for the credential Worker to check against a client-supplied prefix, while `<field>Context` binds every wrapped column to itself so its ciphertext can never be substituted for another column's.

| Column | Wrapped under | Context column |
| --- | --- | --- |
| `$users.umk` | `user_root_key` | `$users.umkContext` |
| `keyStore.keyStoreKey` | owner's `umk` | `keyStore.keyStoreKeyContext` |
| `keyStore.privKey` | `keyStoreKey` | `keyStore.privKeyContext` |
| `credStore.credStoreKey` | owner's `umk` | `credStore.credStoreKeyContext` |
| `credStore.content` | that row's `credStoreKey` | `credStore.contentContext` |
| `txt.txtKey` | owner's `umk` | `txt.txtKeyContext` |
| `txt.prefix` | that document's `txtKey` | `txt.prefixContext` |
| `txt.pendingTxtKey` | owner's `umk` | `txt.pendingTxtKeyContext` |
| `txt.pendingPrefix` | `pendingTxtKey` | `txt.pendingPrefixContext` |
| `txt.staleR2Prefix` | owner's `umk` | `txt.staleR2PrefixContext` |
| `txtMetadata.content` | that document's `txtKey` | `txtMetadata.contentContext` |
| `txtMetadata.catalog` | that document's `txtKey` | `txtMetadata.catalogContext` |
| `txtParts.txtPartKey` | that document's `txtKey` | `txtParts.txtPartKeyContext` |
| `txtParts.path` | that part's own `txtPartKey` | `txtParts.pathContext` |
| `txtParts` R2 object body | that part's own `txtPartKey` | `txtParts.bodyContext` |
| `txtParts.pendingTxtPartKey` | `pendingTxtKey` | `txtParts.pendingTxtPartKeyContext` |
| `txtParts.pendingPath` | `pendingTxtPartKey` | `txtParts.pendingPathContext` |
| `txtShares.txtKey` | per-share `ss` (Encapsulate) | `txtShares.txtKeyContext` |
| `txtAccess.txtAccessKey` | owner's `umk` | `txtAccess.txtAccessKeyContext` |
| `txtAccess.content` | that row's `txtAccessKey` | `txtAccess.contentContext` |
| `txtBookmarks.txtBookmarkKey` | owner's `umk` | `txtBookmarks.txtBookmarkKeyContext` |
| `txtBookmarks.content` | that row's `txtBookmarkKey` | `txtBookmarks.contentContext` |

`txtParts.bodyContext` has no corresponding InstantDB "body" field to sit next to — the value it protects is the R2 object itself, not an InstantDB column — so it lives on the `txtParts` row alongside `txtPartKey`/`path`/their own context columns, the same place `txtPartKey` already lives despite also protecting something stored only in R2.

Most of these columns exist for uniformity rather than necessity. `txtKey`, `txtPartKey`, `credStoreKey`, and a per-share `ss` are each already unique to one document, one part, one specific row, or one (document, recipient) pair, so a fixed per-field label would already prevent confusion between the different columns each one wraps, with no randomness required. The two spots where a random value is actually load-bearing are `credStore.credStoreKey` and `txt.txtKey`/`txt.pendingTxtKey`/`txt.staleR2Prefix`: an owner's single `umk` wraps many `credStore` rows and many `txt` rows at once, and nothing else about those rows tells one apart from another. Applying the same `<field>Context` column uniformly everywhere trades a small amount of storage for not having to re-derive, and keep correct as the schema evolves, exactly which columns need it.

## Design notes

- **Every part's own `txtPartKey`, layered under the document's `txtKey`, bounds a compromised part to that one part.** `txt.prefix` (document-level) is wrapped directly under `txtKey`; a part's `path` and its R2 object body are both wrapped under that row's own `txtPartKey` instead — two independent applications of `txtPartKey`, one protecting the R2 _address_, one the part's _content_. Compromising a single part's `txtPartKey` never exposes another part of the same document, nor the document-level `prefix`, both of which stay under `txtKey` alone. Compromising R2 list/read access alone (without any `txtPartKey`) yields neither the mapping from part to object nor the ability to decrypt any object it did manage to guess.
- **Every `credStore` row has its own intermediate key.** A user's own row and the admin's recovery copy for that user can intentionally describe the same account, but their plaintext payloads serve different purposes and their ciphertexts are independent because each row has a different random `credStoreKey`, wrapped under a different owner's `umk`.

# R2 Storage Layout — Design

The owner has one random content prefix. Its plaintext value comes from
the encrypted credential payload after the browser unwraps the singleton
`owner` row (`docs/auth.md` §3). It exists only in unlocked browser
memory; D1 stores only its fixed-length SHA-256 binding, not the prefix
itself.

```text
s3://{bucket}/{db_prefix}/documents/{path}
s3://{bucket}/{db_prefix}/shared/{share_path}
s3://{bucket}/{db_prefix}/catalog/{catalog_path}
```

`db_prefix`, `path`, `share_path`, and `catalog_path` are each independent
32-byte random values rendered as 52 lowercase base32-Crockford
characters. One literal marker plus one random segment per object: the
literal `documents`/`shared`/`catalog` segments keep objects out of each
other's way inside `{db_prefix}/`, so a second random segment per object
adds nothing the fixed name doesn't already provide.

## Owner document objects

`{db_prefix}/documents/{path}` is one immutable encrypted EPUB referenced
by the owner's `documents` row (`docs/data_model.md`). Replacing a book
creates a new row and object rather than overwriting content beneath
saved CFIs.

## Owner catalog object

`{db_prefix}/catalog/{catalog_path}` is the one R2 object holding every
document's display metadata, referenced by the singleton `catalog` row
(`docs/data_model.md` §2.1). Written only by ingestion tooling; read
directly by the browser.

## Shared document objects

`{db_prefix}/shared/{share_path}` is an independently encrypted copy
created by the owner for one public share (`docs/sharing.md`). It never
reuses the owner's document key or object segments.

## Credentials

The Worker mints two separate temporary credentials for the browser,
rather than one undifferentiated prefix grant:

- a 15-minute read-write credential for `{db_prefix}/documents/*` and
  `{db_prefix}/shared/*`;
- a separate 15-minute read-only credential for `{db_prefix}/catalog/*`
  — the browser only ever needs to _read_ the catalog object (only
  ingestion tooling writes it), so a blanket read-write grant would give
  the browser more than it needs.

Minting goes through Cloudflare's account-level R2 temporary-credentials
API (`POST accounts/{account_id}/r2/temp-access-credentials`), not the
Workers R2 binding — the binding has no method for issuing scoped,
temporary credentials at all, only direct object operations from inside
the Worker itself, which this design deliberately never uses for content
bytes. The call is authenticated with a standing parent R2 API token
(`docs/deployment.md` §2: `R2_PARENT_API_TOKEN` as the bearer credential,
`R2_PARENT_ACCESS_KEY_ID` as that same token's `parentAccessKeyId`); a
temporary credential can never exceed its parent token's own permissions,
so the parent token itself is scoped to this one bucket with read-write
access.

A public recipient receives only a presigned `GET` for one shared object,
minted by the Worker at redemption time (`docs/sharing.md`), never a
standing credential.

## Path and access rules

- Every application path segment is validated before use in a request
  URL.
- The bucket name, endpoint, and region are configuration, not secrets.
- Browser code never receives a standing R2 credential — only the
  15-minute temporary ones above.
- CORS allows exactly the deployed UI origin, methods
  `GET`/`PUT`/`HEAD`, request headers
  `Range`/`If-Match`/`If-None-Match`/`Content-Type`/`Cache-Control` plus
  the SigV4 headers the client emits, and exposes
  `ETag`/`Content-Length`/`Content-Range`/`Accept-Ranges`. No wildcard
  origin.
- The Worker never proxies EPUB bytes; it only mints scoped credentials
  or presigned URLs for direct browser-to-R2 transfer.

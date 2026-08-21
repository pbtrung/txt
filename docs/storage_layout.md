# R2 Storage Layout — Design

The owner has one random database object path and one random content prefix. The
plaintext values come from the encrypted credential payload after the browser
reads and unwraps the singleton rqlite record. They exist only in unlocked
browser memory. rqlite stores their fixed-length SHA-512 binding, not the two
owner paths themselves.

```text
s3://{bucket}/{db_path}
s3://{bucket}/{db_prefix}/{txt.txt_prefix}/{txt.path}
s3://{bucket}/{db_prefix}/shared/{txt_shares.share_prefix}/{txt_shares.share_path}
s3://{bucket}/{rqlite_control_backup}{rqlite-managed-backup-object}
```

## Owner database

`{db_path}` is the complete SQLCipher library database. The browser downloads it
without HTTP caching, retains its ETag, opens it locally, and uploads changes
with `If-Match`. Initial creation uses `If-None-Match: *`.

## Owner EPUB objects

`{db_prefix}/{txt_prefix}/{path}` is one immutable encrypted EPUB referenced by
the owner's local `txt` row. `txt_prefix` and `path` are independent 32-byte
values rendered as 52 lowercase base32-Crockford characters. Replacing a book
creates a new row and object rather than overwriting content beneath saved CFIs.

## Shared EPUB objects

`{db_prefix}/shared/{share_prefix}/{share_path}` is an independently encrypted
copy created by the owner for one public share. It never reuses the owner's EPUB
key or object segments. The browser uploads it directly with the owner's
temporary prefix credential.

rqlite maps `SHA-256(share_id)` to `SHA-256(exact object path)` while the share
is active. The share URL carries an API-encrypted grant containing the path; on
redemption, the API decrypts the grant and verifies its path hash before creating
a 60-second presigned GET URL. The recipient downloads directly from R2;
Northflank does not proxy the object.

## Control backups

The prefix configured by `rqlite_control_backup` is server-only and excluded
from owner temporary credentials.
The rqlite `-auto-backup` process writes its supported hot-backup object directly
to private R2 storage using `RQLITE_BACKUP_CONF`. It is not a copied `db.sqlite`
file from the live volume. R2 server-side encryption protects it at rest, and
the bucket policy permits access only to the backup credential. Backup object
names never include the owner UID or a share capability.

## Path and access rules

- Every application path segment is validated before use in a request URL.
- The bucket name, endpoint, and region are configuration, not secrets.
- The owner receives 15-minute read-write authorization for the exact database
  object and owner prefix.
- A public recipient receives only a presigned `GET` for one shared object.
- Temporary owner credentials cannot access the configured backup prefix; the
  maintenance cleaner preserves that prefix if its credential can list it.
- Browser code never receives the parent R2 secret. The owner unlock file does
  contain the Basic credentials for `/operator/rqlite/`; the UI uses them only
  to read the singleton wrapped-key row and keeps them in page memory.

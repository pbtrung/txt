# Storage Layout — Design

## 1. Object layout

`user_handle`, `db_path`, `db_prefix`, and `db_master_key` (256 random bytes, base64-encoded — the SQLCipher key for the file in §1) all come from encrypted `cred_store.content` after `/v1/keys` (docs/auth.md §2 and §5). That endpoint also returns a 24-hour Worker-signed binding ticket. The client submits the ticket, decrypted handle, two paths, and a fresh versioned P-521 proof to `/v1/r2-token` for handle binding, possession checking, pair-binding authorization, and scoped R2 credentials. Renewing R2 credentials requires neither another Firebase token nor a Turso lookup while the ticket remains valid.

```
s3://{bucket}/{db_path}
s3://{bucket}/{db_prefix}/{txt.txt_prefix}/{txt.path}
s3://{bucket}/{db_prefix}/shared/{txt_shares.share_prefix}/{txt_shares.share_path}
```

The first is the user's whole SQLCipher database. The second is one immutable owner document per `txt` row. The third is an independently encrypted copy created only by the administrator for one public share (docs/sharing.md). Every random path component is stored as 32 raw bytes and rendered as 52 lowercase base32-Crockford characters. A shared copy never reuses the owner's `txt_key`, `txt_prefix`, or `path`.

`{bucket}` is not a secret, but the client carries no R2 connection details of its own — `bucket`, along with the endpoint and region, travels in the `/v1/r2-token` response itself (docs/auth.md §4.2), the client's only source of R2 configuration.

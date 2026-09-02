# Cloudflare-Native Architecture — Design Proposal

This is a proposal, not the shipped design. It describes an alternative
architecture that runs the whole application — gateway, control database, and
static UI — as Cloudflare services under one Cloudflare account, sized to fit
inside Cloudflare's free tier. None of it is implemented; `docs/auth.md`,
`docs/data_model.md`, `docs/storage_layout.md`, `docs/sharing.md`,
`docs/crypto.md`, and `docs/deployment.md` describe the current, shipped
design and are unaffected by this proposal.

The application is reachable at a single host, `sub.domain.com`. The API
lives under `sub.domain.com/v1/*`; every other path serves the static UI.

## 1. Scope and component mapping

| Current (Northflank)                             | Proposed (Cloudflare)                                                |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| OpenResty gateway container                        | One Worker, handling both `/v1/*` and static asset requests           |
| rqlite (control database)                          | D1                                                                     |
| Owner's SQLCipher database file in R2               | Rows in the same D1 database (§4) — no whole-file database object     |
| Cloudflare Pages (static UI)                        | The same Worker's static assets binding                               |
| Firebase Authentication                             | Cloudflare Access, in front of the Worker (§3)                        |
| rqlite-backed rate-limit counters                   | One Cloudflare WAF rate-limiting rule covering all of `/v1/*` — no D1 counter table (§6) |
| R2 (EPUB content, shared copies, control backups)   | Unchanged mechanism, changed object-key layout (§5)                   |
| `RQLITE_ADMIN_USERNAME`/`PASSWORD` operator passthrough | Removed entirely — nothing proxies raw SQL to a client (§4)       |

## 2. Topology

One Worker serves the whole `sub.domain.com` host:

- Requests to `/v1/*` run the API's route handlers.
- Every other request falls through to the Worker's static assets binding
  (`dist/`, built from the same React UI), configured with
  `not_found_handling: "single-page-application"` so client-side routes
  resolve to `index.html`.
- The Worker holds a D1 binding for the unified database (§4) and an R2
  binding used only to mint scoped, time-limited credentials for direct
  browser-to-R2 transfer of EPUB bytes — the Worker itself never proxies
  document content, preserving the current design's rule that large binary
  transfers bypass the API process.

A Cloudflare Access application gates only `/v1/*` at the edge, before any
request reaches the Worker (§3) — not the whole `sub.domain.com` host. The
one exclusion within `/v1/*` is `POST /v1/shared-url`, which stays reachable
by anonymous recipients redeeming a share, exactly as today's `/v1/*`-wide
origin check already carves out.

Static assets (the SPA shell — `index.html` and its JS/CSS bundle) are never
gated by Access at all, for anyone. They carry no confidential data, and the
owner's authenticated app and the public shared-reading page are served from
the *same* single-page bundle: gating the asset paths would also block the
shared-reading page's own JS/CSS from loading for a recipient who was never
meant to pass Access in the first place, since a browser that fetches
`/shared#...` still has to fetch its script and style assets from other,
unrelated paths before it can render anything. What actually needs
protecting — the wrapped key material and the ability to mutate the
library — lives entirely behind `/v1/*`, which the static bundle can reach
or fail to reach depending on whether the visitor has a valid Access
session; the bundle itself is safe to hand to anyone.

## 3. Identity: Cloudflare Access replaces Firebase

Firebase Authentication is removed. A Cloudflare Access application in front
of `/v1/*` (§2) is configured with exactly one policy: `Include: emails
equals OWNER_EMAIL`, using either the One-Time PIN login method (an emailed
code, no external identity provider) or a Google login restricted to that one
address — both are available on Access's free plan, which covers up to 50
authenticated seats at no cost; this app uses one. Use the Google option only
if that Google account already has a passkey or hardware security key
enrolled: without one, Google login is single-factor (password) just like
One-Time PIN, and a bare password on a heavily phished account is arguably
worse than an emailed code, not better — the security gain from choosing
Google over One-Time PIN comes entirely from the phishing-resistant second
factor, not from the provider name. If that isn't already true of the
account, One-Time PIN is the simpler, self-contained choice: it doesn't tie
this app's front door to a separately managed third-party account's security
posture drifting over time. This mirrors the current
design's actual invariant ("there is exactly one authenticated principal")
more directly than comparing a UID in application code: nobody without a
successful Access login for `OWNER_EMAIL` can reach the gated paths at all,
including `/v1/*` request handlers that never run.

Access forwards every gated request to the Worker with a signed
`Cf-Access-Jwt-Assertion` header. The Worker still verifies it independently
(signature against the team domain's JWKS, `aud` equal to this Access
application's tag, `exp`, and `email` equal to the configured `OWNER_EMAIL`)
rather than trusting the edge unconditionally — the same defense-in-depth
reasoning as validating a Firebase token's issuer and audience today, and it
gives the Worker an authenticated identity claim to embed in the owner
binding ticket in place of the Firebase `sub`.

**The SPA has to handle an Access challenge, not a normal API error.** A
`fetch()` to a gated `/v1/*` path from a browser without a valid Access
session doesn't reach the Worker at all — Access intercepts it and responds
with its own login challenge, typically an HTML redirect to the Access
login page, not a JSON body or a clean `401`. The UI needs to treat that
response shape (a non-JSON body, a redirect, or a cross-origin failure if
`fetch()` follows the redirect into Access's login domain) as "not logged
in, prompt to authenticate," rather than assuming every `/v1/*` response is
either valid JSON or a same-origin API error the way it is today against
Firebase-gated Northflank endpoints.

**Is proof-of-possession still needed?** Yes, unchanged. Access answers a
different question than the proof-of-possession protocol in `docs/auth.md`
§4.2/`docs/crypto.md`: Access establishes that *this browser session* logged
in as the owner and is authorized to reach `/v1/*` at all. It says nothing
about whether the caller also possesses `user_root_key` and the resulting
unwrapped P-521 signing key — material that never leaves unlocked browser
memory and that Access never sees. A stolen `Cf-Access-Jwt-Assertion` /
`CF_Authorization` session cookie is, from the Worker's perspective, exactly
as much a bearer credential as a stolen Firebase ID token was: without also
stealing the unlock file's `user_root_key` and completing the unwrap, an
attacker holding only the Access session cannot produce a valid proof and
therefore cannot obtain R2 write credentials for the library. Dropping proof-
of-possession because "Access already authenticated the request" would make a
stolen session cookie alone sufficient to mint full read-write R2 access to
the whole library — strictly weaker than today.

**Proof-of-possession now has to cover every D1 mutation, not only R2
credentials.** In the current shipped design, a Firebase bearer token alone
(no proof) is already enough to call endpoints like `POST`/`DELETE
/v1/shares`, because the only thing reachable that way is hash-only
control-plane bookkeeping in rqlite — the owner's actual library stays in a
whole-file SQLCipher database that only the unlocked browser ever opens, and
proof-of-possession was scoped narrowly to the one endpoint that hands out
R2 write credentials. That scoping doesn't carry over safely here: §4 puts
the owner's real library — reading state, bookmarks, share grants — directly
into D1, mutated through Worker endpoints. Leaving those endpoints gated by
the Access JWT alone would mean anyone who gets past Access — a stolen
session cookie, without ever touching `user_root_key` — could still tamper
with or destroy that state (delete bookmarks, revoke shares, corrupt reading
position) even though they could never decrypt it. So this proposal extends
the same ticket-and-proof protocol to every D1-*mutating* `/v1/*` endpoint
(reading-state updates, bookmark writes, share create/delete), not only
`/v1/r2-token`: each such request must carry a fresh proof, built exactly as
`docs/crypto.md` specifies, with the canonical proof bytes extended by one
more bound field — `SHA-256(UTF8(method) || 0x00 || UTF8(path) || 0x00 ||
body)`, covering the exact HTTP method, full request path, and body, not
just an "operation name." Binding the *path* matters as much as binding the
body: a target id such as a bookmark or share id typically travels in the
URL (e.g. `DELETE /v1/bookmarks/{id}`) rather than in an otherwise-empty
body, so a proof that only hashed the body would look identical for two
different targets of the same operation — a captured proof for "delete
bookmark #5" could then be replayed against bookmark #7. Hashing the full
method-and-path together with the body closes that: a captured proof
verifies only against the exact request it was signed for. Reads stay behind
the Access JWT alone: a read only ever returns opaque per-row ciphertext
(§4.1), so an attacker without `umk` gains nothing exploitable from it,
unlike a write.

## 4. Unified D1 database

`owner_control` and `shares` (today's rqlite control database) and `txt`,
`txt_bookmarks`, `txt_shares` (today's owner SQLCipher file) become six D1
tables: `owner_control`, `key_store`, `catalog`, `txt`, `txt_bookmarks`, and a
merged `shares`. Nothing proxies raw SQL to a client: the
`RQLITE_ADMIN_USERNAME`/`RQLITE_ADMIN_PASSWORD` operator passthrough has no
equivalent here, since every read and write happens inside a Worker route
handler through the D1 binding. That removes a whole class of risk present
today — a leaked operator password is currently a full control-plane
compromise (`docs/auth.md` §7); there is no comparable credential to leak in
this design.

### 4.1 Per-row keys, not SQLCipher

D1 cannot host a SQLCipher-encrypted file or a custom VFS, so whole-file
encryption is replaced by per-row field encryption using the *same*
primitive already defined in `docs/crypto.md` — the Blob Format and its
Encrypt/Decrypt procedure are unchanged; only their scope widens, and it
widens through one extra layer of indirection rather than by wrapping every
row directly under `umk`.

Every row holding sensitive data gets its own fresh 128-byte random key,
generated client-side at write time; that per-row key is wrapped by the
unwrapped owner master key (`umk`) using the Blob Format's Encrypt procedure,
and the row's own payload is wrapped by the *resulting unwrapped per-row
key* — not by `umk` directly. No new key-derivation primitive is needed
beyond Encrypt/Decrypt applied twice. `key_store` (defined in the unified
schema, §4.2) holds every wrapped per-row key, referenced by the row it
protects.

A per-row key closes a relocation risk the Blob Format's additional data
alone can't: a data blob decrypts only under the specific key its own row's
`*_key_id` points to, so copying one row's ciphertext into another row
simply fails to decrypt there — the whole-file design had no equivalent
boundary between, say, one document's catalog entry and another's. What a
per-row key doesn't defend against is a caller who can also rewrite the
foreign key alongside the blob, which needs D1 write access — i.e. a
compromised Worker, already inside the trusted computing base (§8).

The foreign key points from a data row to its `key_store` row, not the
reverse, so deleting a bookmark or a share doesn't automatically delete the
`key_store` row it protects unless something arranges that — including when
the *bookmark cap trigger* evicts a row automatically, which the caller
can't easily anticipate (it doesn't know in advance which row `ORDER BY id
DESC LIMIT 20` will evict). The unified schema (§4.2) handles this with an
`AFTER DELETE` trigger per table
(`trg_txt_delete_keys`, `trg_txt_bookmarks_delete_key`,
`trg_shares_delete_key`) rather than relying on caller
discipline: each fires on any deletion of its owning row — explicit or
cap-trigger-driven — and removes the corresponding `key_store` row in the
same statement's execution, so an orphan is never created in the first
place. Leaving one out wouldn't leak anything (the orphaned row is still
only wrapped ciphertext), but would let `key_store` grow unbounded.

`key_store` adds one extra write per new bookmark or share row (one data row
plus one key row), and *two* extra writes per new `txt` row, since it
references two independent per-row keys (`content_key_id` and
`access_key_id`); at this app's volume that is still a trivial fraction of
D1's free-tier write budget (§7).

Because of the purpose-check triggers below, the order of writes for a new
row is fixed: insert its `key_store` row(s) first, then the row that
references them. A `BEFORE INSERT` trigger checks `NEW.*_key_id` against
`key_store` at the moment the referencing row is inserted, so that row's
key(s) must already exist — inserting a `txt` row before its
`content_key_id`/`access_key_id` rows would fail the purpose check (or the
`REFERENCES` constraint itself, if enforced) rather than the other way
around.

### 4.2 Schema

```sql
CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE owner_control (
    singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
    created_at                INTEGER NOT NULL,
    owner_email_hash          BLOB    NOT NULL CHECK (length(owner_email_hash) = 32), -- SHA-256(owner_email)
    db_prefix_hash            BLOB    NOT NULL CHECK (length(db_prefix_hash) = 32),   -- SHA-256(db_prefix)
    user_handle_hash          BLOB    NOT NULL CHECK (length(user_handle_hash) = 32), -- SHA-256(user_handle)
    wrapped_umk               BLOB    NOT NULL,
    sign_version              INTEGER NOT NULL CHECK (sign_version = 1),
    sign_algorithm            TEXT    NOT NULL CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
    sign_public_key           BLOB    NOT NULL,
    wrapped_sign_private_key  BLOB    NOT NULL,  -- Blob Format, IKM = umk
    kem_public_key            BLOB    NOT NULL,  -- provisioned, unused by sharing today (docs/crypto.md)
    wrapped_kem_private_key   BLOB    NOT NULL,  -- Blob Format, IKM = umk
    encrypted_credentials     BLOB    NOT NULL   -- {user_handle, display_name, db_prefix}
) STRICT;

-- Holds every per-row key (§4.1), wrapped by umk, referenced by the row it
-- protects.
CREATE TABLE key_store (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose     TEXT    NOT NULL CHECK (purpose IN
                     ('txt_catalog_key', 'txt_content_key', 'txt_access_key',
                      'txt_bookmark_key', 'txt_share_key')),
    wrapped_key BLOB    NOT NULL,  -- Blob Format, IKM = umk; plaintext is 128 random bytes
    created_at  INTEGER NOT NULL
) STRICT;

-- Singleton, like owner_control. Points at the one R2 catalog object (§4.3);
-- holds no document data itself.
CREATE TABLE catalog (
    singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
    key_id       INTEGER NOT NULL REFERENCES key_store(id),
    catalog_blob BLOB    NOT NULL,  -- Blob Format, IKM = key_id's unwrapped key
                                     -- plaintext: {catalog_key, catalog_path}
    updated_at   INTEGER NOT NULL
) STRICT;

-- One row per document. Display metadata lives in the R2 catalog object
-- (§4.3) for fast bulk listing; this row holds what's needed to open and
-- decrypt the one document plus its live reading state.
CREATE TABLE txt (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     INTEGER NOT NULL,
    content_key_id INTEGER NOT NULL REFERENCES key_store(id),
    content_blob   BLOB    NOT NULL,  -- Blob Format, IKM = content_key_id's unwrapped key
                                       -- plaintext: {content_key (128 random bytes), path}
    access_key_id  INTEGER NOT NULL REFERENCES key_store(id),
    access_blob    BLOB    NOT NULL,  -- Blob Format, IKM = access_key_id's unwrapped key
                                       -- plaintext: {last_accessed, last_cfi}
    access_version INTEGER NOT NULL DEFAULT 0  -- optimistic-concurrency counter for access_blob, §4.5
) STRICT;
CREATE TRIGGER trg_txt_delete_keys AFTER DELETE ON txt
BEGIN
  DELETE FROM key_store WHERE id = OLD.content_key_id OR id = OLD.access_key_id;
END;
CREATE TRIGGER trg_txt_key_purpose BEFORE INSERT ON txt
WHEN (SELECT purpose FROM key_store WHERE id = NEW.content_key_id) IS NOT 'txt_content_key'
   OR (SELECT purpose FROM key_store WHERE id = NEW.access_key_id) IS NOT 'txt_access_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for txt row');
END;

CREATE TABLE txt_bookmarks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id        INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    key_id        INTEGER NOT NULL REFERENCES key_store(id),
    bookmark_blob BLOB    NOT NULL  -- Blob Format, IKM = key_id's unwrapped key
                                     -- plaintext: {cfi, page_number, preview}
) STRICT;
CREATE INDEX idx_txt_bookmarks_txt_id ON txt_bookmarks(txt_id, created_at, id);
CREATE TRIGGER trg_txt_bookmarks_cap AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks WHERE txt_id = NEW.txt_id AND id NOT IN (
    SELECT id FROM txt_bookmarks WHERE txt_id = NEW.txt_id
    ORDER BY id DESC LIMIT 20
  );
END;
-- Fires for both the cap eviction above and any explicit application delete,
-- so an evicted or deleted bookmark's key_store row never has to be tracked
-- and cleaned up by caller code (§4.1).
CREATE TRIGGER trg_txt_bookmarks_delete_key AFTER DELETE ON txt_bookmarks
BEGIN
  DELETE FROM key_store WHERE id = OLD.key_id;
END;
CREATE TRIGGER trg_txt_bookmarks_key_purpose BEFORE INSERT ON txt_bookmarks
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'txt_bookmark_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for txt_bookmarks row');
END;

CREATE TABLE shares (
    share_id_hash     BLOB    PRIMARY KEY CHECK (length(share_id_hash) = 32),
    txt_id            INTEGER NOT NULL REFERENCES txt(id) ON DELETE RESTRICT,
    object_path_hash  BLOB    NOT NULL CHECK (length(object_path_hash) = 32),
    key_id            INTEGER NOT NULL REFERENCES key_store(id),
    owner_blob        BLOB    NOT NULL,  -- Blob Format, IKM = key_id's unwrapped key
                                          -- plaintext: {share_id, share_content_key
                                          --             (128 random bytes), share_path}
    state             TEXT    NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
    created_at        INTEGER NOT NULL,
    UNIQUE (object_path_hash)
) STRICT;
CREATE TRIGGER trg_shares_delete_key AFTER DELETE ON shares
BEGIN
  DELETE FROM key_store WHERE id = OLD.key_id;
END;
CREATE TRIGGER trg_shares_key_purpose BEFORE INSERT ON shares
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'txt_share_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for shares row');
END;
CREATE TRIGGER trg_catalog_key_purpose BEFORE INSERT ON catalog
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'txt_catalog_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for catalog row');
END;
```

Without them, nothing would stop a caller from referencing the wrong
`key_store` row for a column — a `CHECK` constraint can only validate a
single table's own columns, not cross-reference another table's, so this
pairing would otherwise be an unenforced, application-level-only invariant.
The purpose-check triggers guard `BEFORE INSERT` only, matching that every
row here is written once and never has its `*_key_id` reassigned afterward;
they turn that silent, undetectable mismatch into an immediate
`RAISE(ABORT)`. Each comparison uses `IS NOT` rather than `!=` deliberately:
if a `*_key_id` pointed at a `key_store` row that doesn't exist at all
(e.g. because `foreign_keys` enforcement turned out to be off, per the
caveat below), the subquery returns `NULL`, and `NULL != 'x'` evaluates to
`NULL` rather than true — a `WHEN` clause that evaluates to `NULL` does not
fire the trigger, so `!=` would let exactly the case these triggers exist
to catch slip through unabridged. `IS NOT` is SQLite's NULL-safe
inequality: `NULL IS NOT 'x'` is always true, so a dangling reference aborts
the insert just as reliably as a wrong-but-present purpose does. The
delete-cascading triggers
(`trg_txt_delete_keys`, `trg_txt_bookmarks_delete_key`,
`trg_shares_delete_key`) mean
`key_store` rows are cleaned up automatically by SQLite/D1 itself whenever
their owning row is deleted — including the bookmark-cap trigger's automatic
eviction above, which the Worker has no direct visibility into (it doesn't
know in advance which row `ORDER BY id DESC LIMIT 20` will evict), so
handling this at the trigger level rather than in application code is not
just more convenient but the only reliable place to catch it.

Before relying on `txt_bookmarks.txt_id ON DELETE CASCADE` or `shares.txt_id
ON DELETE RESTRICT` actually firing, confirm D1 enforces `FOREIGN KEY`
constraints on every connection it uses for these statements: SQLite's
`foreign_keys` pragma is off by default per connection unless explicitly
turned on, and if D1's Workers binding doesn't enable it for every query
path, those two declarative behaviors — and the `REFERENCES` existence
checks generally — would silently not apply. The `key_store`
cleanup/purpose-check triggers above aren't affected by this: plain
`CREATE TRIGGER` objects fire on the `INSERT`/`DELETE` event itself,
independent of the `foreign_keys` pragma, so they're reliable either way.

`txt.id`, `txt_bookmarks.id`, and `key_store.id` are plain `AUTOINCREMENT`
integers rather than 32-byte random base32-Crockford tokens like `db_prefix`,
`path`, and `share_path` (the R2 object-key segments, §5): every read and
write of these ids already goes through an authenticated Worker route scoped
to the one owner (§2), so there is no untrusted caller in a position to
guess or care about an id — unlike those object-key segments, which exist
because they're addressed directly in an R2 request. (`share_id`, the public
bearer capability carried in a share URL fragment, is a different token
again — 32 random bytes but base64url per `docs/sharing.md` §3, not
base32-Crockford; it identifies a `shares` row, not an R2 key segment.)
Random ids here would also cost something concrete for no offsetting
benefit: `INTEGER PRIMARY KEY` is a rowid alias in SQLite/D1, so it's free
and requires no separate index, while a 32-byte token needs a real one and
doubles the size of every foreign key referencing it (`txt_id`,
`*_key_id`) across `txt_bookmarks`, `key_store`, and `shares`. Sequential
integers also give the bookmark cap trigger free, clock-skew-immune
insertion ordering (`ORDER BY id DESC`) — a random token has no inherent
order, so sorting would fall back to the client-supplied `created_at`
timestamp, reintroducing exactly the clock-skew problem `docs/data_model.md`
§2.2 uses `AUTOINCREMENT` to avoid today.

`shares` keeps `object_path_hash` and `state` alongside the per-row-key
pattern, rather than reducing to owner-facing bookkeeping alone: `POST
/v1/shared-url` still needs a server-side lookup from a redeemed capability
to an `active` row, and revocation still needs a state transition, exactly
as `docs/sharing.md` §4 describes today — this proposal keeps that flow
(§3), so `shares` keeps the columns it depends on.

### 4.3 Owner catalog: one R2 object

Everything needed to actually *open* a document (`content_key`, its EPUB
`path`) is authoritative in `txt.content_blob` — the Worker's own library
query already returns that row. What's in the catalog object —
title/authors/subjects/publisher/name — is written once per document at
ingestion time and never mutated afterward, purely to make the Library
screen's initial browse/search list fast: fetching and decrypting one object
that already holds every document's display fields is strictly cheaper than
N D1 rows and N per-row decrypts.

- **Format:** one Blob Format ciphertext (a single AEAD call, not one per
  document) wrapping a JSON array — `[{txt_id, catalog}, ...]`,
  brotli-compressed exactly as `docs/data_model.md` §2.1's `catalog` column
  is today; this is highly repetitive text (titles, authors, subjects),
  unlike the row-level blobs in §4.4, which don't compress.
- **Key and path:** two layers, matching `txt.content_blob`'s pattern — a
  `key_store` key wraps the *row*, and the row's own plaintext carries a
  separate key for the *R2 object*. `txt_catalog_key` decrypts
  `catalog.catalog_blob`, whose plaintext is `{catalog_key, catalog_path}`;
  `catalog_key` actually encrypts the R2 object.
- **Written by:** the maintenance tooling that ingests or updates documents
  (today's `ingest.py`/`db_updater.py`; whether it calls the Worker or a D1
  binding directly is open, §9) — a whole-object overwrite, with no risk of
  two writers racing since ingestion is single-operator.
- **Read by:** the browser, directly from R2 with its temporary
  `{db_prefix}/*` credential (§2/§5) — no Worker involvement in serving the
  object's bytes.

**Write order and recovery.** The `txt` row (D1) and the catalog object (R2)
are two independent stores with no cross-system transaction — unlike today,
where the catalog entry and its `txt` row are part of the same whole-file
object uploaded atomically in one conditional `PUT` (`docs/data_model.md`
§1). Ingestion must insert the new `txt`/`key_store` rows into D1 *first*,
then rewrite the catalog object second. That ordering makes an interruption
between the two steps a safe, self-correcting state rather than a broken
one: a `txt` row that exists but isn't in the catalog is simply invisible in
the Library screen's list until the next ingestion run — it isn't lost, and
isn't reachable through a dangling reference either. The reverse order would
be worse: a catalog entry could reference a `txt_id` that doesn't exist in
D1 yet, which the Library screen would show and then fail to open. Ingestion
re-runs are idempotent for this reason: each run should reconcile by
checking for any `txt` row not yet represented in the current catalog object
and adding it, rather than assuming the previous run's catalog rewrite
necessarily completed.

**Scaling assumption.** Because catalog is one object holding *every*
document's display metadata, adding a single new book means fully
downloading, decrypting, re-encrypting, and re-uploading the entire catalog
object, not just appending an entry. This is deliberately traded for the
Library screen's single-fetch simplicity (§4.3's opening paragraph) and
holds up fine at personal-library scale (hundreds to low thousands of
documents); a library large enough for that whole-object rewrite to become
slow or costly would need per-document catalog entries instead, giving up
the single-object-fetch benefit for incremental updates.

### 4.4 Plaintext encoding: MessagePack, not JSON, and never brotli-compressed

Every `plaintext: {...}` payload in §4.2's row-level blobs — `content_blob`,
`access_blob`, `bookmark_blob`, `owner_blob`, `catalog.catalog_blob`, and
`encrypted_credentials` — is dominated by either raw 128-byte random keys or
already-random path/id tokens, with only a few small fixed-size or
capped-length fields alongside:

- **MessagePack, not JSON:** JSON has no binary type, so embedding a raw
  128-byte key means base64-encoding it first — pure overhead that then
  gets encrypted along with everything else for no benefit. MessagePack's
  native `bin` type keeps it 128 bytes plus a couple of header bytes.
  `docs/crypto.md`'s Blob Format is serialization-agnostic; this is a choice
  about what these callers feed Encrypt/Decrypt, not a change to the format
  itself.
- **Named fields (map), not positional (array/tuple) encoding,** despite
  array encoding being more compact: `docs/crypto.md`'s versioning policy
  requires that an older decoder can still decode a newer-minor blob by
  ignoring unknown fields, which only holds with named fields.
- **No brotli compression:** high-entropy key material and random tokens
  don't compress, and brotli's own overhead can make a payload this small
  *larger*, not smaller. Whether a blob type compresses is a fixed,
  caller-known convention per use (`docs/crypto.md`'s Decrypt step 8), not a
  header flag — the one exception in this design is the R2 catalog object
  itself (§4.3), which is large, repetitive JSON text and keeps brotli for
  the same reason `docs/data_model.md` §2.1 does today.

### 4.5 Read/write model change

The current design downloads the whole encrypted database file, mutates it
locally, and re-uploads it with a conditional R2 `PUT` (`docs/data_model.md`
§1). D1 has no equivalent whole-file access; the browser instead sends
individual, already-encrypted field values to purpose-built `/v1/*`
endpoints, which the Worker writes as parameterized D1 statements inside a
D1 transaction. This drops the local wasm SQLCipher engine entirely.

**D1's transactions are not a drop-in replacement for the ETag
conflict-retry loop, though.** A D1 transaction guarantees one statement or
batch is atomic and consistent; it says nothing about two *different*
requests, from two devices, each independently reading then overwriting the
same row — the exact race the ETag mechanism exists to catch.
`txt.access_blob` is the row most exposed to this: two devices syncing
reading position near-simultaneously could otherwise silently lose
whichever update loses the race to land last, with no error raised.
`txt.access_version` (§4.2) exists specifically to close this: every
update to
`access_blob` is a conditional statement, `UPDATE txt SET access_blob = ?,
access_version = access_version + 1 WHERE id = ? AND access_version = ?`,
using the version number the client's own read returned. `access_key_id`
itself never changes on these updates — the same per-row key encrypts every
successive `access_blob` for that row, with a fresh salt and nonce each time
per the Blob Format (`docs/crypto.md`); rotating it here would mint a new
`key_store` row on every coalesced 15-second reading-state write with no
trigger positioned to clean up the old one, since the delete-cascading
triggers (§4.2) fire on row *deletion*, not on an in-place `*_key_id`
change. Zero rows affected means another write landed first; the Worker
returns `412` for this, the same status the current design's conditional
`PUT` gives on a whole-file conflict, so the client's existing `412`-retry
handling needs no new status code to recognize — and the client re-fetches
the row and reapplies its semantic mutation, exactly as
`docs/data_model.md` §1 step 7 already does for the whole file. Bookmark and
share rows don't need this: they're created and deleted, not read-modified-
and-written-back in place, so there's no analogous lost-update window for
them.

Because `access_blob` encrypts `last_accessed` and `last_cfi` together, D1
cannot `ORDER BY` reading state — the Library screen's recency sort happens
client-side, after one request returns every `txt` row plus the catalog
object (§4.3) for the browser to decrypt and sort locally. That request
should `JOIN txt` against `key_store` (on both `content_key_id` and
`access_key_id`) rather than fetch each row's keys with a separate query per
row — an N+1 pattern here would multiply D1's per-query overhead across the
whole library on every Library-screen load, working against the same
free-tier read/CPU budgets (§7) this design is trying to stay comfortably
under. That's the same trade the current design already accepts by keeping
this data behind `db_master_key` today; it also means reading the library
requires a round trip to the Worker rather than opening a fully offline
local copy, a real behavior change worth confirming is acceptable before
adopting this proposal. EPUB content itself is unaffected: it stays in R2,
fetched and decrypted client-side exactly as today.

## 5. R2 usage

One literal marker plus one random segment per object, plus a third marker
for the catalog object (§4.3):

```text
s3://{bucket}/{db_prefix}/txt/{path}
s3://{bucket}/{db_prefix}/shared/{share_path}
s3://{bucket}/{db_prefix}/catalog/{catalog_path}
```

`db_prefix`, `path`, `share_path`, and `catalog_path` are each independent
32-byte random values rendered as 52 lowercase base32-Crockford characters,
the same encoding `docs/storage_layout.md` and `txt/random_token.py` already
use for this kind of R2 object-key segment. The third line's segment is
named `catalog_path` rather than reusing `path`, matching the field name
`catalog.catalog_blob`'s own plaintext already uses for it (§4.2) — `path`
in `txt.content_blob`'s plaintext is a different, independently random value
for a different object, and giving them the same placeholder name here would
suggest otherwise.

This replaces `docs/storage_layout.md`'s current two-random-segment layout
(`{db_prefix}/{txt_prefix}/{path}` for owner content,
`{db_prefix}/shared/{share_prefix}/{share_path}` for shared copies) and
drops the whole-file
database object (`{db_path}`) entirely, since that data now lives in D1
(§4). The literal `txt`/`shared`/`catalog` segments already keep objects out
of each other's way inside `{db_prefix}/`, so a second random segment per
object adds nothing the fixed name doesn't already provide.

CORS configuration and presigned-URL minting are otherwise unchanged from
the current design: the Worker still never proxies EPUB bytes, only mints
short-lived scoped credentials or presigned URLs for direct browser-to-R2
transfer, exactly as the current API does today.

**Scope the browser's credential narrower than the current design's single
prefix grant.** Today, the whole-file database object gets its own exact-
object credential, separate from the broader prefix credential used for
EPUB content (`docs/auth.md` §4.2) — two credentials, not one, deliberately
limiting what a single grant can reach. Folding `catalog/` into the same
general `{db_prefix}/*` read-write credential the browser already gets for
`txt/` and `shared/` would lose that separation: per §4.3, the browser
should only ever need to *read* `catalog/*` (only the maintenance tooling
writes it), so a blanket read-write grant gives the browser more than it
needs and reintroduces exactly the kind of unnecessarily broad credential
the current design avoids. Mint two credentials instead of one, mirroring
today's exact-object-plus-prefix split rather than presuming R2's
temporary-credential API can express mixed read-write/read-only permissions
across different prefixes within a single grant: one read-write credential
for `{db_prefix}/txt/*` and `{db_prefix}/shared/*`, and a separate read-only
credential for `{db_prefix}/catalog/*`. Confirm against R2's actual
temporary-credential policy capabilities whether these can be collapsed
into one multi-statement credential later; two credentials is the safer
default to design against.

## 6. Rate limiting

Cloudflare's WAF rate-limiting rules on the free plan give this zone exactly
**one** custom rule, but a single rule can match every path under `/v1/*` and
still keep a separate counter per endpoint: adding **URI Path** to the rule's
counting characteristics buckets requests by path automatically, so the rule
does not collapse `/v1/keys`, `/v1/r2-token`, `/v1/shares`, and
`/v1/shared-url` into one shared counter. That is enough to cover the whole
API surface with the one free rule — counting happens at Cloudflare's edge,
before a request reaches the Worker or D1 at all, which is also better for
the 100,000-request daily Workers budget (§7) than a Worker-side counter
would be.

Configured rule (set directly in the Cloudflare dashboard, not automated —
consistent with this app's single-operator, low-change-frequency deployment
style):

- Match: `starts_with(http.request.uri.path, "/v1/")`
- Counting characteristics: `ip.src` and URI Path (so each endpoint gets its
  own counter per client IP)
- Period / threshold: 10 seconds / 20 requests
- Action: Block (or Managed Challenge, if a soft block is preferred for the
  public endpoint)

One rule means one threshold and one period shared by every bucket it
creates — this is the real trade-off against the four independently
calibrated numbers the current design uses (`docs/auth.md` §6: 60/hour,
30/hour, 120/hour, 120/minute). 20 requests per 10 seconds is the same
average rate as the current `public-share-url` budget (120/minute) but in a
shorter window, so it catches a burst faster rather than letting it run for
up to a minute before tripping — a tighter fit for the one scope that faces
unauthenticated internet traffic. Applied to the three owner scopes, the
same rule is still numerically looser than today's hourly caps in absolute
terms (up to 7,200/hour instead of 30–120/hour) — but those three are now
behind Cloudflare Access (§3), so the threat model they defend against has
already narrowed from "anyone holding a stolen bearer token" to "a
compromised or malfunctioning owner session," and a 10-second burst cap
stops a runaway loop faster than an hourly counter ever could. If usage ever
shows that looser owner-endpoint ceiling is a real problem, a per-scope cap
can be reintroduced later as a small Workers KV counter — cheaper to add
than a D1 counter table, since it wouldn't need relational structure.

Because counting now happens in Cloudflare's edge infrastructure rather than
in this application's own database, the current design's "fail closed with
`503` if rqlite is unreachable" concern (`docs/auth.md` §6) no longer applies
to rate limiting specifically — it becomes part of Cloudflare's own
availability rather than a dependency this design has to reason about.

## 7. Free-tier budget

Confirm current figures against the Cloudflare dashboard at deploy time —
free-tier allowances change — but as of this proposal:

| Resource                        | Free allowance                                              | Fit for a single-owner app                                    |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Workers requests                 | 100,000 / day                                                 | Comfortable; one owner plus occasional anonymous share reads     |
| Workers CPU time                 | 10 ms / invocation                                             | JWT/HMAC/P-521 verification and small D1 queries are well under this; profile before relying on it — P-521 proof verification now runs on every mutating `/v1/*` handler (§3), not only `/v1/r2-token`, so profile that whole class, not just one endpoint |
| D1 storage                       | 5 GB                                                            | Metadata and wrapped keys only — content stays in R2              |
| D1 rows read                     | 5,000,000 / day                                                 | Comfortable at personal-library scale                             |
| D1 rows written                  | 100,000 / day                                                   | Comfortable even with `key_store`'s extra write per new row (two for a new `txt` row, §4.1); reading-state writes stay coalesced as in `docs/data_model.md` §2.2 |
| D1 free-tier enforcement         | Hard failure once a daily cap is hit (in effect since 2026-09-01) | No headroom for a runaway loop — keep the rate limit in §6        |
| Workers static assets            | 20,000 files                                                    | Far more than this UI's build output                              |
| Cloudflare Access seats           | 50 users                                                         | One owner uses one seat                                           |
| WAF rate-limiting rules           | 1 custom rule                                                   | Allocated in §6                                                    |
| R2                                | Unchanged from the current deployment                           | Already in production use                                          |

D1 also has built-in point-in-time recovery ("Time Travel"), which can
replace the current `rqlite -auto-backup`-to-R2 mechanism and its
`rqlite_control_backup` prefix; confirm the retention window included on the
account's plan before treating it as a full backup replacement.

## 8. Trust boundary

Unchanged in spirit from `docs/auth.md` §8: the unlocked browser and the
Worker are trusted; D1 is trusted for authorization state and durability but
receives only wrapped or encrypted owner material and hashes, never
plaintext content or an unwrapped key — rate limiting now lives entirely at
Cloudflare's edge (§6), so D1 holds no counter state either. R2 is trusted for object
durability but not plaintext confidentiality. Cloudflare Access is trusted to
gate request arrival to the one configured owner identity, which is
sufficient on its own for reads; per §3, it is never treated as a substitute
for proof-of-possession on any endpoint that mutates D1 or mints R2
credentials. The Worker does not hold
`user_root_key`, `umk` unwrapped, any per-row key from `key_store` unwrapped,
the raw P-521 or KEM private keys, or any share content key; a compromised
Worker can authorize R2 access (it is inside the trusted computing base, as
the API is today) but a copied D1 export alone cannot decrypt the library.

## 9. Open questions

These are not resolved by this proposal:

- Whether the owner's Google account already has a passkey or hardware
  security key enrolled — §3 gives a decision rule (Google login only if so,
  One-Time PIN otherwise) but not the answer, which is specific to that
  account.
- A migration path for existing R2-hosted SQLCipher data into D1 rows plus
  the R2 catalog object (§4.3), and whether the Python maintenance CLI
  (`txt/`) is ported to call the Worker's D1 binding or rewritten around
  D1's own HTTP API/`wrangler d1` tooling.
- Whether D1's native migration tooling (`wrangler d1 migrations`) replaces
  the bespoke `schema_migrations` tracking this proposal keeps for parity
  with the current design.
- Confirming current Access, D1, and Workers free-tier figures against
  Cloudflare's dashboard immediately before implementation, since §7's
  figures can change.

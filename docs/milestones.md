# Implementation Milestones

A build plan for the design in `docs/auth.md`, `docs/data_model.md`,
`docs/storage_layout.md`, `docs/sharing.md`, `docs/crypto.md`, and
`docs/deployment.md`. Each milestone ships a working, independently
testable slice; later milestones depend on earlier ones being merged and
green.

**Out of scope for this plan:** migrating the existing R2-hosted SQLCipher
database and rqlite control data into the new D1 schema. That is a
separate, later piece of work — do not build a migration path as part of
any milestone below, and do not delete the current Northflank deployment
or its data until that separate migration work exists and has been run.

**Testing standard for every milestone:** a milestone is not done when the
code compiles — it's done when its tests catch the failure modes below
that apply to it, and those tests actually fail before the fix and pass
after. Every milestone that touches encryption, concurrency, or
authorization needs tests that deliberately try to break the guarantee,
not just tests that confirm the happy path. Vitest for TypeScript
(Worker and UI share a runtime — both are JS/TS against Web Crypto),
`wrangler dev`/Miniflare with a local D1 database for anything that needs
a real D1 binding, and pytest for the Python tooling.

---

## Milestone 0 — Repo scaffolding

**Status: done.** `worker/` holds the Worker source; `wrangler.jsonc`
declares the entry point, static assets binding, D1 binding, and an R2
binding (real bucket name supplied only at deploy time via `BUCKET_NAME`,
never committed). `txt-dev` and `txt-ci` D1 databases are provisioned.
`Env` comes from `wrangler types`' generated output rather than a
hand-maintained duplicate. Tests run inside the real Workers runtime via
`@cloudflare/vitest-pool-workers` (`worker/tests/index.test.ts`).

- Add a `worker/` directory (or `src/worker/`, matching whatever the UI
  build's existing layout prefers) for the Worker's TypeScript source,
  separate from `ui/`.
- `wrangler.jsonc`: declare the Worker entry point, `dist/` as the static
  assets directory with `not_found_handling: "single-page-application"`,
  a D1 binding (`DB`), and an R2 binding, replacing the current
  `pages_build_output_dir`-only config.
- Provision a development D1 database (`wrangler d1 create txt-dev`) and
  a matching one for CI.
- `npm run` scripts: add `worker:dev` (`wrangler dev`), `worker:test`,
  `worker:typecheck`; remove nothing yet — Lua/docker scripts are
  Milestone 9's job, not this one's.

**Test:** `wrangler dev` boots and serves a placeholder `/v1/health`
returning `200` and the built UI shell at `/`.

## Milestone 1 — D1 schema and migration tooling

**Status: done.** Schema changes are tracked with `wrangler d1 migrations`
(`worker/migrations/0001_initial_schema.sql`), not a bespoke
`schema_migrations` table — documented in `docs/data_model.md` §2.
`PRAGMA foreign_keys` was confirmed on by default in D1 and not something
a caller can turn off (`PRAGMA foreign_keys = OFF` runs without error but
doesn't change subsequent enforcement) — `worker/tests/db.test.ts` proved
this empirically rather than assuming it, so no startup assertion was
needed. Tests run against a real D1 binding via
`@cloudflare/vitest-pool-workers`, not a mocked SQLite.

- Apply the schema in `docs/data_model.md` §2 to the dev D1 database.
  Decide now whether schema changes are tracked with `wrangler d1
migrations` or the bespoke `schema_migrations` table the design keeps
  for parity with today's `RqliteUpdater` — pick one and document the
  choice in `docs/data_model.md` rather than leaving it open.
- Confirm `PRAGMA foreign_keys` is actually on for every connection the
  Worker uses. If D1's binding API doesn't guarantee this by default,
  find and use whatever mechanism does, and add a runtime assertion (or
  a startup check) that fails loudly if it's off — silent unenforced
  foreign keys is exactly the failure mode `docs/data_model.md` §2
  flags.
- Implement the schema against a real D1 binding, not a mocked SQLite —
  D1's actual behavior (trigger execution order, `STRICT` table
  enforcement, `foreign_keys` default) is the thing under test.

**Test, specifically targeting the correctness issues the design already
identified and fixed on paper:**

- Insert a `documents` row whose `content_key_id` references a
  `key_store` row of the _wrong_ purpose → `trg_documents_key_purpose`
  aborts.
- Insert a `documents` row whose `content_key_id` references a
  _nonexistent_ `key_store` row → still aborts, with the trigger's own
  error message (not a generic constraint error) — proving the `BEFORE
INSERT` trigger catches it before the `FOREIGN KEY` constraint even
  runs. Disabling `foreign_keys` to isolate this turned out to be
  unnecessary: D1 doesn't allow it to be disabled in the first place
  (see Status above), and a `BEFORE INSERT` trigger fires before the `FK`
  check regardless. This is the specific `IS NOT` vs. `!=` regression to
  guard against: write this test first, confirm it fails against a
  `!=`-based trigger, then confirm it passes
  against the shipped `IS NOT` version.
- Insert 25 bookmarks for one document → exactly 20 remain, and
  `SELECT count(*) FROM key_store WHERE purpose = 'bookmark_key'` shows
  no orphans from the 5 evicted rows.
- Delete a `shares` row directly → its `key_store` row is gone too.
- Attempt to delete a `documents` row referenced by an `active` share →
  rejected (`ON DELETE RESTRICT`).

## Milestone 2 — Crypto module

Two independent pieces on opposite sides of the trust boundary
(`docs/auth.md` §7) — not both "usable from both the Worker and the
browser," which was this milestone's original, wrong framing:

1. **Blob Format** (`docs/crypto.md` — Ascon-Keccak/HKDF-SHA3-512):
   unchanged from what exists today (`ui/src/crypto/{aead,cryptoBlob}.ts`),
   browser-only — nothing to build here. This is what still encrypts the
   shared EPUB copy itself (`docs/sharing.md` §4 step 4), uploaded
   directly to R2 by the browser; the Worker never touches EPUB bytes or
   `share_content_key`. Two earlier drafts of this milestone got this
   wrong in opposite directions: one asked to confirm the Blob Format's
   leancrypto WASM loads inside the Workers runtime (it does, but the
   Worker has no legitimate reason to decrypt row data at all, so this
   didn't belong here); the other moved the shared-EPUB encryption itself
   to a new browser-side AES-256-GCM module, when the design never called
   for changing how EPUB content is encrypted — only for encrypting the
   object _path_ differently, which is a Worker-side concern, below.
2. **Share grant envelope** (`docs/crypto.md` §"Share grant envelope" —
   AES-256-GCM/HKDF-SHA-256, replacing the XChaCha20-Poly1305 scheme this
   design's predecessor used): new, pure `crypto.subtle`, no WASM, in the
   Worker (`worker/`) — this is genuinely Worker-side, unlike the Blob
   Format, because the Worker is the only party that holds
   `SHARE_GRANT_KEY` and the only party that ever encrypts or decrypts a
   grant (`docs/sharing.md` §3.2/§3.3).

**Test, for the share grant envelope:**

- Round-trip: encrypt then decrypt recovers the exact object path string.
- Tamper detection: flip one bit anywhere in `sealed`, in `salt`, or in
  `version` → decrypt rejects, every time.
- A grant produced for one `share_id` (`id_hash`) is rejected when
  decryption is attempted under a different `id_hash` — the additional-data
  binding `docs/crypto.md` describes, tested directly rather than assumed.
- Nonce/salt uniqueness: encrypt the same object path under the same
  `SHARE_GRANT_KEY`/`id_hash` twice → different salts, different nonces,
  different envelopes.
- Known-answer test: pin at least one fixed `SHARE_GRANT_KEY`/`id_hash`/
  path/expected-envelope tuple as a regression test, generated once and
  committed, so a future refactor that silently changes byte layout gets
  caught immediately instead of only in an integration test.

## Milestone 3 — Access-gated Worker skeleton

**Status: code and tests done, including the UI-side Access challenge
handling; live-deployment verification of the Access application itself
is confirmed working by the operator.** `worker/access.ts` verifies the
Access JWT (signature via a real RSA keypair in tests, `aud`, `iss`,
`exp`, `email`); `worker/api.ts` gates every `/v1/*` route except `POST
/v1/shared-url` behind it, with a `requireVar()` check that refuses to
run against an unsubstituted `replace-me-*` placeholder rather than
silently comparing against it. `ui/src/data/apiClient.ts` treats a
non-JSON response or a `fetch()`-level failure from a gated path as a
distinct `AccessRequiredError`, and `VaultContext.tsx`/`UnlockScreen.tsx`
surface it as a "log in with Cloudflare Access" prompt rather than a
parse error.

- Route `/v1/*` (minus `/v1/shared-url`) through Access JWT verification
  (`docs/auth.md` §2): signature against the team domain's JWKS, `aud`,
  `exp`, `email == OWNER_EMAIL`.
- Confirm — by actually configuring a Cloudflare Access application
  against a real `*.workers.dev` or preview deployment, not just unit
  tests — that static assets and `/shared` load with zero Access
  session, and that every other `/v1/*` path is unreachable without one.
  This is exactly the class of bug that's easy to get right in code and
  wrong in dashboard configuration; the design doc's own audit caught it
  once already (an earlier draft gated the whole host, which would have
  broken the public shared-reading page's own JS/CSS) — verify the
  actual deployed behavior, not just the code path.
- UI: handle the Access challenge shape (`docs/auth.md` §1) — a redirect
  or non-JSON response from an unauthenticated `/v1/*` call — as "prompt
  to log in," not as a parse error or an uncaught rejection.

**Test:** an integration test that hits every declared `/v1/*` route
without an Access session and asserts each one either the correct
success behavior (`/v1/shared-url`) or a non-200 that isn't a raw
Worker crash.

## Milestone 4 — Owner ticket and proof of possession

**Status: done, Worker and client sides both.** `worker/ownerTicket.ts`
issues and verifies the HS256 ticket; `worker/ownerProof.ts` builds and
verifies the canonical proof bytes; `worker/ownerEndpoint.ts` wires `GET
/v1/owner` to the D1 `owner` row. `ui/src/data/ownerProof.ts` builds and
signs the same canonical bytes client-side with `crypto.subtle.sign`
(P-521/SHA-512), independently implemented from the Worker's verifier
but cross-checked by both sides' test suites against the same
`docs/crypto.md` construction.

- Implement ticket issuance (`docs/auth.md` §4.1) and proof verification
  (`docs/auth.md` §4.2) exactly per the canonical-bytes construction in
  `docs/crypto.md`.
- Implement client-side signing with `crypto.subtle.sign` (P-521/SHA-512)
  and Worker-side verification with `crypto.subtle.verify` against the
  ticket's `sign_public_key`.

**Test — this is the highest-value place to be adversarial, since it's
the layer standing between "past Access" and "can mutate the library":**

- A valid proof for `DELETE /v1/bookmarks/5` rejected when replayed
  against `DELETE /v1/bookmarks/7` — the specific cross-resource-replay
  gap the design closed by binding method+path+body into the signature.
  Write this test before trusting the implementation; it should fail
  against a naive "operation name + body" binding and pass against the
  full method/path/body binding.
- An expired proof (`expires_at` in the past) rejected.
- A proof signed with the right key but a stale/expired ticket rejected.
- A structurally valid but wrong-length signature (not exactly 132
  bytes) rejected.
- A proof for the right request but wrong `db_binding_hash` rejected.

## Milestone 5 — Document and reading-state endpoints

**Status: done, Worker and client sides both.** `GET /v1/documents`
returns the N+1-avoiding join; `PATCH /v1/documents/:id/access`
implements the `access_version` optimistic-concurrency update;
`GET`/`POST`/`DELETE /v1/bookmarks` and `GET /v1/bookmarks/summary` (a
later addition, for the Library screen's bookmark badges without an
N+1 fetch per book) cover listing, creation, and deletion. Re-bookmarking
the same CFI is enforced client-side (a real gap in this doc's earlier
text, fixed above) — the Worker never holds an unwrapped key to decrypt
`bookmark_blob` itself. `ui/src/data/libraryStore.ts` replaced the local
SQLCipher-via-WASM engine entirely for this data: there is no local
database file anymore, and `ui/src/data/sqlite.ts`/`schema.ts`/
`databaseStore.ts`/`libraryDb.ts` were removed once nothing referenced
them.

- Worker endpoints for library listing (join `documents`↔`key_store`,
  §"avoiding N+1", `docs/data_model.md` §3), reading-state updates
  (`docs/data_model.md` §4), and bookmark create/delete.
- Client-side: replace the local SQLCipher-via-WASM engine with these
  endpoints entirely for this data. There is no local database file
  anymore for this milestone's data — confirm the old engine's code
  paths for it are actually unreachable, not just unused.

**Test:**

- The `access_version` conflict path specifically: two concurrent
  `UPDATE`s to the same `documents.access_blob` with a stale version →
  one succeeds, the other gets `412`. Simulate this with two overlapping
  requests in the same test, not just by reasoning about the SQL —
  concurrency bugs are exactly the kind that look correct on paper.
  Confirm the client's retry-on-`412` path actually recovers to a
  consistent final state.
- The N+1-avoidance query returns correct data for a library with zero,
  one, and many documents — a join bug that only manifests with
  multiple rows is the kind that a single-document dev environment
  won't catch.

## Milestone 6 — R2 credentials

**Status: Worker-side minting done and tested against a mocked Cloudflare
API; the live-deployment test below hasn't been run.**
`worker/r2CredentialsEndpoint.ts` implements `POST /v1/r2-credentials`
(ticket + proof required, `docs/auth.md` §4.3), calling Cloudflare's
account-level R2 temp-access-credentials API — confirmed against the real
API docs (not the Workers R2 binding, which has no such method at all,
a real gap fixed in `docs/storage_layout.md` and `docs/deployment.md`
above) to support exactly the two-credential, prefix-scoped split this
design calls for. `worker/tests/r2CredentialsEndpoint.test.ts` verifies
the Worker's own request shape (permission/prefixes/bucket per
credential) and response mapping against a mocked Cloudflare API, and
that ticket/proof gating and an upstream API failure are both handled.
The "actually attempt a `PUT` against `catalog/*`" test below needs a
live deployment, a real R2 API token, and a real bucket — none of which
exist in this session — and hasn't been run; do that as part of release
verification (`docs/deployment.md` §7) instead.

- Mint the two separate credentials from `docs/storage_layout.md`
  §"Credentials": read-write on `documents/*` and `shared/*`, read-only
  on `catalog/*`.
- Confirm R2's actual temporary-credential API can express this split as
  designed (the design doc flags this as unverified against R2's real
  capabilities) — if it can't, the two-credential approach is still the
  fallback, so this milestone should not need a design change, only
  confirmation.

**Test:** actually attempt a `PUT` against `catalog/*` using the
read-only credential and confirm R2 rejects it — a scope claimed in code
comments that isn't enforced by the actual minted credential is worse
than no comment at all.

## Milestone 7 — Sharing

**Status: done, Worker and client sides both.**
`worker/sharesEndpoint.ts` implements `GET`/`POST`/`DELETE /v1/shares`;
`worker/sharedUrlEndpoint.ts` implements `POST /v1/shared-url`, minting a
single-object 60-second R2 credential through the same Cloudflare API
`worker/r2CredentialsEndpoint.ts` uses (reusing `createMintCredential`,
generalized to accept an object/prefix scope and a TTL) and presigning
the `GET` locally with `aws4fetch` — no hand-rolled SigV4 signing, and no
new secret to derive an S3-style key from the parent R2 API token. `GET
/v1/shares` (a read endpoint, not in the original bullet list below) was
added because the design's own rationale for `owner_blob` — "so the
owner's browser can list active shares" (`docs/sharing.md` §1) — is
unimplementable without one, the same gap Milestone 5 found for
bookmarks. Two real bugs were found and fixed in `docs/sharing.md` while
implementing this: §3.1's `POST /v1/shares` body sent `share_content_key`
to the Worker in plaintext and said "the Worker... wraps" `owner_blob`,
and §3.3's `DELETE /v1/shares` said the Worker "re-derives... from the
row's decrypted `owner_blob`" — both impossible, since the Worker never
holds an unwrapped key. Both endpoints now take an already-encrypted
`owner_blob` plus a plaintext `share_path` the Worker can hash and
compare directly, matching the trust boundary the rest of the design
already follows. `ui/src/data/shares.ts` implements the creation flow
(§4) and `ui/src/data/sharedReader.ts`/`useSharedReaderDocument.ts`/
`useSharedReadingState.ts` implement the recipient flow (§5); the
shared-reading page's bookmark/reading-state persistence stays entirely
in `localStorage`, keyed by the capability, and never touches the
owner's D1 rows. The "Bundle-size or import-graph assertion" test below
was not written — the shared-reading route's independence from the
leancrypto/WASM module is a property of `sharedReader.ts` never
importing `crypto/aead.ts`, not something enforced by an automated
check.

- Implement `POST /v1/shares`, `POST /v1/shared-url`, `DELETE
/v1/shares` per `docs/sharing.md` §3, using the grant envelope
  (`docs/crypto.md` §"Share grant envelope", already implemented in
  Milestone 2's `worker/shareGrant.ts`) and the Milestone 2
  sharing-content encryption for the EPUB copy itself.
- UI: the creation flow (§4) and recipient flow (§5), including the
  shared-reading page's use of the sharing-content decoder — confirm
  this page's bundle does not pull in the leancrypto module at all,
  since that's the specific reason the design put sharing content on a
  separate native-only format.

**Test:**

- Full lifecycle: create → redeem → revoke → redeem again fails with
  `404`/no-active-share, indistinguishable from "capability never
  existed."
- Revocation racing an in-flight redemption: start a redemption, revoke
  before it completes, confirm the already-issued 60-second URL's
  documented behavior (remains valid until expiry unless the object is
  already deleted) rather than an undefined race.
- Idempotent re-registration: calling `POST /v1/shares` twice with the
  same capability and path succeeds both times; with the same capability
  and a _different_ path returns `409`.
- Bundle-size or import-graph assertion that the shared-reading route
  doesn't transitively import the leancrypto/WASM module.

## Milestone 8 — Rate limiting

- Configure the WAF rule from `docs/auth.md` §6 directly in the
  Cloudflare dashboard, not in code (matching the design's stated
  reasoning: this is a single-operator, low-change-frequency setting).
- Document the exact configured values in `docs/auth.md` if they end up
  different from the design's 20-req/10s starting point.

**Test:** a load-testing script (adapt the existing rate-limit
load-test approach) that drives `POST /v1/shared-url` past the
threshold from one IP and confirms the configured action (Block/Managed
Challenge) actually fires, run against a real deployed preview, since
WAF rules aren't something `wrangler dev` simulates locally.

## Milestone 9 — Ingestion tooling

**Status: `--init-owner` and `--ingest` done and tested against the D1
design; `--update-db`/`--clean-bucket`/`--clean-db` deferred to their own
pass.** Decided the Worker-endpoints-vs-D1-HTTP-API question in favor of
D1's own HTTP query API (`txt/d1_client.py`) — the Worker's ticket/proof
protocol is designed for ephemeral browser sessions, not a long-running
CLI carrying its own Cloudflare API token, matching how `r2_client.py`
already holds a real, standing R2 credential rather than going through a
Worker endpoint. `txt/owner_init.py` was rewritten around a D1 `owner`
row (schema installation is now Worker-managed, via `wrangler d1
migrations`, not this tool's job); `txt/ingest.py` was rewritten to write
`documents`/`key_store` rows directly and reconcile the R2-hosted catalog
object via a local checkpoint file (`docs/data_model.md` §2.1 documents
why a checkpoint is required — a `documents` row alone can't say what its
catalog entry should contain). `txt/rqlite_client.py`,
`rqlite_schema.py`, `rqlite_updater.py`, and `firebase_auth.py` had no
remaining callers once this landed and were removed entirely.
`ingest.py`'s own rewrite no longer uses `sqlite_engine.py` at all, but
that module stays: `db_updater.py`, `bucket_cleaner.py`, and
`db_cleaner.py` still target the rqlite-era design (a whole downloaded
SQLCipher file, `self.owner.rqlite`) and still need it. Those three
aren't wired into `cli.py` until they get the same D1 rewrite — their
tests skip themselves at import time rather than fail.

- The Python maintenance CLI's ingestion path (`txt --ingest`,
  `txt --update-db`) needs to write to D1 and the R2 catalog object
  instead of a local SQLCipher file — decide whether it calls the
  deployed Worker's endpoints or D1's own HTTP API directly, and update
  `docs/data_model.md` §2.1's "Written by" note with the answer once
  decided.
- The catalog-object write order from `docs/data_model.md` §2.1 (D1 rows
  first, then the catalog rewrite, with idempotent reconciliation on
  re-run) needs to be implemented exactly as designed, not
  approximated — this is the piece that keeps a crashed ingestion run
  self-healing instead of corrupt.
- `sqlite_engine.py` (the whole-file SQLCipher-via-WASM engine) has no
  remaining caller once Milestone 5 lands — remove it rather than
  leaving dead code. `leancrypto_wasm.py` and `crypto_blob.py` stay:
  ingestion still writes Blob-Format-encrypted rows for `documents`,
  `catalog`, and `key_store`.

**Test:**

- Kill an ingestion run after the D1 writes but before the catalog
  rewrite → re-running it completes the catalog update without
  duplicating or losing the D1 rows already written.
- Run ingestion twice on an unchanged source directory → second run is a
  no-op (no duplicate `documents` rows, no unnecessary catalog rewrite).

## Milestone 10 — Deployment and release verification

**Status: D1 database and R2 bucket provisioning automated in
`scripts/deploy.sh` (idempotent: resolves or creates each by name, then
applies pending D1 migrations before deploying); the Access application,
WAF rate-limiting rule, and the full `docs/deployment.md` §7 checklist
still need a real Cloudflare account and dashboard access neither this
session nor `wrangler` has — `wrangler` has no Access-application
commands at all, confirmed while implementing this. `scripts/deploy.sh`'s
Pages-specific invocation was already removed in an earlier milestone.**

- Provision the production D1 database, R2 bucket bindings, Access
  application, and WAF rule per `docs/deployment.md`.
- Remove `scripts/deploy.sh`'s Pages-specific invocation once the Worker
  deploy path (`wrangler deploy`) replaces it.
- Run every check in `docs/deployment.md` §7 against the real
  deployment, in order, before calling this milestone done — that
  section exists specifically as the acceptance test for everything
  above.

**Test:** `docs/deployment.md` §7's checklist, executed against a real
Cloudflare account (a staging one first), not simulated.

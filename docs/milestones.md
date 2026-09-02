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
   grant (`docs/sharing.md` §3.1/§3.2).

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

**Status: code and tests done; live-deployment verification still
pending.** `worker/access.ts` verifies the Access JWT (signature via a
real RSA keypair in tests, `aud`, `iss`, `exp`, `email`); `worker/api.ts`
gates every `/v1/*` route except `POST /v1/shared-url` behind it, with a
`requireVar()` check that refuses to run against an unsubstituted
`replace-me-*` placeholder rather than silently comparing against it.
The second bullet below — configuring a _real_ Cloudflare Access
application against a live deployment — is a real, visible
infrastructure change (Zero Trust org config, a live URL) and hasn't
been done in this pass; it needs an explicit decision to actually deploy
and configure Access before it can be checked off. The UI-side Access
challenge handling (third bullet) is UI work, not yet started.

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

**Status: Worker side (ticket issuance, `GET /v1/owner`, proof
verification) done and tested; client-side signing not started.**
`worker/ownerTicket.ts` issues and verifies the HS256 ticket;
`worker/ownerProof.ts` builds and verifies the canonical proof bytes and
is exported so a future client-side signer reuses the exact same
construction; `worker/ownerEndpoint.ts` wires `GET /v1/owner` to the D1
`owner` row. The client-side signing bullet below is UI work, deferred
to when a mutating endpoint (Milestone 5) actually needs to send a
proof.

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

- Implement `POST /v1/shares`, `POST /v1/shared-url`, `DELETE
/v1/shares` per `docs/sharing.md` §3, using the D1-direct lookup (no
  grant envelope) and the Milestone 2 sharing-content encryption for the
  EPUB copy itself.
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

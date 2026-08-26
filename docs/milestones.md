# Migration to Scaleway — Milestones

This is a migration plan, not a description of the currently deployed system.
It replaces `docs/deployment.md`'s Northflank/OpenResty/Lua/rqlite stack with:

- **Rust** instead of OpenResty/LuaJIT for the gateway;
- **Scaleway Serverless Containers** instead of Northflank for hosting it;
- **Turso** instead of rqlite for the control database;
- **Cloudflare Pages** unchanged for the static UI.

Every functional and security guarantee in `docs/auth.md`, `docs/sharing.md`,
`docs/crypto.md`, `docs/control_database.md`, and `docs/storage_layout.md`
carries over unless a milestone below says otherwise. Those documents remain
the contract; this document is the plan to rebuild a system that satisfies it
on different infrastructure, plus the places where the new infrastructure
forces (or enables) a genuine design change.

## What does not change

- R2's object-key layout, presigning, and CORS story (`docs/storage_layout.md`).
- The owner's SQLCipher database schema and the browser's read-write round
  trip (`docs/data_model.md`).
- The Blob Format and Share Grant Envelope (`docs/crypto.md`) — both are
  implemented client-side (browser) and CLI-side (Python), not by the
  gateway, so a gateway rewrite does not touch them at all.
- The Python maintenance CLI's *interface* (`--init-owner`, `--update-db`,
  `--clean-bucket`, `--clean-db`, `--update-rql` or its Turso-migration
  equivalent) — its `rqlite_client.py` backend is replaced, but `creds.json`'s
  shape and the commands' behavior stay the same wherever possible.
- Cloudflare Pages, `wrangler.jsonc`, and `scripts/deploy.sh` — confirmed
  unrelated to the backend platform; the UI's API base URL is already a
  runtime value read from the owner's unlock file (`ui/src/data/rqlite.ts`,
  `ui/src/data/apiClient.ts`), not a build-time constant. Cutover is a URL
  change, not a UI code change.

## Milestone 0 — Resolve the architecture before writing code

This migration was proposed as "private serverless container, gated by an
`X-Auth-Token`, so an attack can't hit the API — remove rate limiting." That
premise does not hold as stated, for a specific, verifiable reason, and this
milestone exists to fix the premise before any Rust is written.

### Finding: private containers and the public surface are incompatible on Scaleway

Scaleway Serverless Containers' private mode checks the `X-Auth-Token`
against IAM **at Scaleway's own edge**, before the request reaches the
container — so a caller without that secret cannot reach a private container
at all, full stop. That is real, effective protection. But **Scaleway
requires `privacy = public` to attach a custom domain** — private mode and a
custom domain (needed to sit behind Cloudflare, or to have a stable API
origin at all) are mutually exclusive on this platform. There is no
Scaleway-native API Gateway/WAF product to front a container either; their
own docs describe "public container + your own CDN" as the pattern.

That collides with this system's actual traffic, which is not
one-caller-holds-a-shared-secret: `docs/auth.md` and `docs/sharing.md`
require this gateway to accept requests from three distinct kinds of
caller that don't share one Scaleway IAM secret:

1. **The owner's browser**, authenticated per-request by a Firebase ID
   token, a ticket, or a P-521 proof — **resolved below.**
2. **An anonymous share recipient's browser** (`docs/sharing.md` §6),
   authenticated by nothing but possession of a 256-bit capability. This
   is the one surface that must accept a cold, unauthenticated request from
   literally any browser on the internet, by design — **deliberately left
   open for now.** Whatever serves `/v1/shared-url` cannot require a secret
   of any kind, so it needs its own resolution independent of caller 1; do
   not assume it inherits caller 1's answer.
3. **The Python CLI's operator**, today via the Basic-authenticated
   `/operator/rqlite/` route, tomorrow via a direct, admin-scoped Turso
   connection from the operator's own machine — this one *can* legitimately
   be a private, secret-gated call, since it has no browser in the loop, and
   needs no further design work here.

### Decision: caller 1 (the owner's browser) gets the private container after all

The owner's unlock file already hands the browser a secret of equivalent
weight for the same reason: `rqlite_admin_password` today, kept only in page
memory, never persisted, never sent anywhere but the operator route
(`docs/auth.md` §1, §8). There is exactly one authenticated principal in this
whole system — the owner — so adding one more secret to that same file
doesn't widen any existing trust boundary.

**Decision:** add a `SCALEWAY_AUTH_TOKEN` field (naming TBD) to the owner's
unlock JSON, sourced the same way `rqlite_admin_password` is today. The
browser calls the owner-only container's **default Scaleway domain directly
(no custom domain, so no conflict with private mode)**, with that token in
the `X-Auth-Token` header. Scaleway's edge rejects anyone without it before
the request reaches the Rust gateway at all — genuinely private, not merely
application-checked, for every owner-only endpoint (`/v1/keys`,
`/v1/r2-token`, `/v1/shares` create/delete, `/v1/owner-row`). No Cloudflare
involved in this path.

**Open, must-verify-before-Milestone-1:** Scaleway's IAM check happens at
its edge, ahead of your code. A browser precedes any cross-origin request
carrying a custom header with a CORS **preflight** (`OPTIONS`, no
`X-Auth-Token` on it by spec). If Scaleway's edge applies the same IAM gate
to that preflight, it 403s before the browser ever gets to send the real
request — no secret, correct or not, would matter, and this whole approach
fails regardless of what's in the unlock file. Test this against a real
private container before committing further design to it. If it does block
preflights, the fallback is a one-endpoint public shim (same shape as
whatever caller 2 ends up needing) that forwards to the private container
with the header attached server-side — worth keeping in mind while caller 2
gets resolved, since the two problems may end up sharing a solution.

### Caller 2 remains unresolved — do not silently default it to caller 1's answer

No decision recorded here yet. `/v1/shared-url` still needs *some* path with
zero credential requirement, and Milestone 5's abuse-control work is blocked
on that decision, not on caller 1's. Revisit before Milestone 4 reaches this
endpoint.

### Decision: rate limiting narrows for owner-scoped calls, stays open for the public one

`docker/lua/txt/rate_limit.lua`'s four scopes split differently now that
caller 1 is IAM-gated:

- **`owner-keys`, `owner-r2-token`, `owner-share-write`**: these already sat
  behind Firebase auth or an owner ticket, where the limiter was
  defense-in-depth, not the only control. They now *also* sit behind
  Scaleway's IAM gate, so the realistic attacker has to have compromised the
  owner's unlock file (already close to full compromise on its own) before
  either check matters. **Decision: keep them anyway** — ported directly
  from `rate_limit.lua`, backed by Turso — since they're cheap, already
  built, and still catch a buggy retry loop or a partially-leaked secret
  that hasn't yet been rotated.
- **`public-share-url`**: unresolved, tracked under caller 2 above. Whatever
  container/path ends up serving it, Milestone 5 still applies the same
  reasoning already recorded there — Scaleway's only native cost bound
  (`max-scale`) fails closed, so *some* abuse control has to exist on that
  path; which layer provides it depends on caller 2's answer.

### Decision: stop handing the browser a raw-SQL-capable credential

Unrelated to the platform move but surfaced while re-deriving this contract:
today's browser holds the *same* Basic credential the CLI's operator tooling
uses (`docs/storage_layout.md`, `ui/src/data/rqlite.ts`), and nothing
server-side stops it from sending any SQL statement to `/operator/rqlite/`,
not just the one hardcoded `SELECT` the browser actually needs — a prior
security review of this codebase flagged exactly this as a real
least-privilege gap. `/operator/rqlite/` is a dumb `proxy_pass`, not an
endpoint with its own logic, so there was nothing to narrow.

The new gateway does not need that shape. **Decision:** replace it with a
real endpoint, `GET /v1/owner-row`, that runs one hardcoded, parameterized
query server-side and returns exactly the columns `ui/src/data/rqlite.ts`'s
`OWNER_SQL` already selects today (`firebase_uid`, `wrapped_umk`,
`sign_version`, `sign_algorithm`, `wrapped_sign_private_key`,
`encrypted_credentials`) — the browser gets the same data it gets today,
through an endpoint that cannot be asked to run a different query, full
stop. This is a distinct call from `/v1/keys` (`docs/auth.md` §4.1, which
additionally mints the R2 ticket) — it's a straight replacement for the raw
row read the browser currently does through `/operator/rqlite/`. The CLI's
operator connection keeps a real admin-scoped Turso token, used only from
the operator's own machine, never the browser — the same trust boundary
`docs/auth.md` §8 already describes for the parent R2 key.

### Open questions to close out before Milestone 1

- [ ] **Blocking, test first:** confirm whether Scaleway's private-container
      IAM gate lets a CORS preflight (`OPTIONS`, no custom headers) through
      to the point where the container's own CORS response can be returned,
      or whether the gate 403s the preflight itself. This decides whether
      the caller-1 decision above is viable at all as designed.
- [ ] **Blocking, not yet decided:** how caller 2 (`/v1/shared-url`) is
      exposed — deliberately deferred above, but Milestone 4 cannot port
      that endpoint and Milestone 5 cannot design its abuse control until
      this is answered.
- [ ] Confirm Turso's actual request timeout / max response size limits for
      `turso_serverless` against Scaleway's own container timeout, so
      neither silently truncates the other.
- [ ] Confirm whether Turso's platform tokens support any read-only or
      table-scoped restriction. It doesn't change the `/v1/owner-row`
      decision above (the gateway never becomes SQL-injectable to the
      browser either way), but a scoped token would let the *operator's*
      day-to-day tooling (`--update-db`, `--clean-db`) run with less than
      full admin rights too, tightening that boundary further.
- [ ] Confirm Scaleway's exact request timeout ceiling (300 s confirmed as a
      configurable value; the platform maximum wasn't confirmed during
      research) against the slowest current gateway call
      (`firebase_id_token.lua`'s JWKS fetch has a 3 s timeout budget; R2/
      Turso calls should be comparably bounded).

**Exit criteria:** this section's decisions are reviewed and accepted (or
explicitly revised) by the owner before any Rust code is written. Milestones
1–9 assume caller 1's and caller 3's resolutions above; every place they
touch caller 2 says so explicitly and is blocked on it, not on an assumed
answer.

## Milestone 1 — Rust workspace and a parity test harness

Goal: a Rust workspace that builds and runs an empty gateway, plus the
scaffolding to prove every later port is byte-for-byte behaviorally
identical to the Lua reference before it replaces it.

- Pick the HTTP framework (axum is the natural fit: tower middleware for
  Origin/method checks maps directly onto `request.lua`'s
  `require_method`) and the crate set for what Milestone 2 needs:
  `sha2`/`hmac` (HS256, HMAC-based rate-limit subject hashing),
  `subtle` (constant-time comparison — see the checklist below),
  `base64` (canonical, non-alphabet-tolerant decode — `codec.lua`'s
  `base64_decode`/`base64url_decode` reject non-canonical encodings on
  purpose; confirm the chosen crate does too, or wrap it), `p521`/`ecdsa`
  or the `openssl` crate for P-521 verification, `aws-sigv4` (the official
  AWS Rust crate — see the note under Milestone 2), `libsodium-sys` or a
  pure-Rust XChaCha20-Poly1305 crate (`chacha20poly1305`) for the share
  grant envelope, `turso_serverless` (or `libsql` with the `remote`
  feature) for the database, `reqwest` for outbound Firebase/R2 calls with
  a mockable client (see below), `jsonwebtoken` only if it can be made to
  produce this codebase's exact HS256 format — otherwise hand-roll it as
  thinly as `jwt.lua` does.
- **Build the HTTP client as a trait from day one**, not a concrete
  `reqwest::Client`, and inject a mock implementation in tests. This
  directly addresses a real, previously-shipped bug class in this codebase:
  `aws_sigv4.lua` was completely untestable because it required a real
  OpenResty runtime dependency at load time, and its canonical-request
  builder shipped a live bug (an extra blank line before `SignedHeaders`,
  breaking every signed request) that was only caught by a production 403.
  The Rust port must not be structurally untestable the same way.
- Build a **golden fixture suite**: capture real request/response pairs
  from the current Lua gateway (or synthesize them from
  `docker/lua/tests/*_test.lua`'s existing fixtures, re-expressed as JSON)
  for every endpoint — success paths and every documented failure status in
  `docs/auth.md` §4 and `docs/sharing.md` §4's status tables. Milestones 2–4
  replay these against the new implementation and diff exact status codes,
  JSON field names, and header values, not just "it returns 200."
- Set up `cargo test`, `cargo clippy -- -D warnings`, and `cargo audit` (or
  `cargo deny`) in CI from the start — the equivalent of this repo's
  existing `ruff`/`eslint`/`luacheck` gates.

**Exit criteria:** an empty Rust service starts, answers `/health/live`, and
CI runs the (still mostly empty) test/lint/audit suite green.

## Milestone 2 — Port the crypto and auth primitives

Port each of these with unit tests asserting byte-identical output against
known vectors (re-derived from the existing Lua test suite's fixtures),
*before* wiring any of them into an HTTP handler:

| Lua module | Rust equivalent | Parity risk to test explicitly |
| --- | --- | --- |
| `codec.lua` (`digest`, `hmac`, base64/base64url, `equal`) | `sha2`, `hmac`, `base64`, `subtle` | `codec.equal` is a hand-written constant-time compare; Rust's `==` on slices is **not** constant-time (it short-circuits) — use `subtle::ConstantTimeEq` or `ring`'s verify function explicitly, and add a timing-insensitivity test note (a real regression class, not a hypothetical one) |
| `jwt.lua` (HS256 sign/verify) | hand-rolled or `jsonwebtoken` pinned to HS256 | exact header (`{"alg":"HS256","typ":"JWT"}`) byte order and base64url canonicalization must match, since `/v1/r2-token` receives tickets minted by whichever code signed them |
| `firebase_id_token.lua` (RS256 verify + JWKS cache) | `jsonwebtoken` or `openssl` + a cache | JWKS caching is per-process today (`ngx.shared.firebase_certs`); a serverless container has no shared state across instances, so expect more frequent JWKS fetches under scale-out — bound this with an in-process TTL cache per instance, not a design blocker, but note it so cold-start-heavy traffic doesn't hammer Google's endpoint |
| `owner_proof.lua` (raw IEEE P1363 → DER, P-521 verify) | `p521`/`ecdsa` crate, or `openssl` | the 132-byte raw-signature format and the exact canonical-proof byte layout in `docs/crypto.md` (`"txt:r2-ticket-proof"` domain-separated construction) must be reproduced exactly, or the browser's existing `crypto.subtle.sign` output stops verifying |
| `sodium.lua` + `share_grant.lua` (XChaCha20-Poly1305 grant envelope) | `chacha20poly1305` crate (`XChaCha20Poly1305`) | HKDF-free but HMAC-based key derivation (`HMAC-SHA-256(salt, SHARE_GRANT_KEY)` then `HMAC-SHA-256(prk, info‖id_hash‖0x01)`) must match exactly, or every share grant minted before cutover stops decrypting after it |
| `aws_sigv4.lua` (presigned GET, R2 object delete, local-signing temp credentials) | the official `aws-sigv4` crate | **do not hand-roll this again** — see the bug history noted in Milestone 1. The R2 "local signing" scheme (`docs/auth.md` §4.2, verified against Cloudflare's own docs during the original audit of this codebase) is a specific, documented protocol, not an ad hoc design; confirm the chosen crate's canonical-request builder matches Cloudflare's expectations exactly, with a real R2 bucket in the test loop before trusting it |
| `owner_r2_credentials.lua` | port directly | same local-signing math as above; this mints the temporary R2 credentials the browser uses for every object read/write, so a subtle bug here breaks the entire storage layer, not just one endpoint |

**Security & edge-case checklist for this milestone:**

- [ ] Tampered/truncated/wrong-length signatures, tags, and MACs are
      rejected, not panicked on — Rust's `?`-heavy style makes it easy to
      `unwrap()` a slice conversion; every parser here takes attacker-
      controlled bytes and must return `Result`, never panic.
- [ ] Every comparison of a secret-derived value (HMAC tags, signature
      verification results already handled by the crypto crate, but also
      any hand-written check) goes through a constant-time path.
- [ ] Non-canonical base64/base64url (extra padding, alternate alphabet
      characters) is rejected the same way `codec.lua` rejects it today —
      confirm the chosen crate's decoder is strict by default or wrap it.
- [ ] `firebase_id_token.lua`'s claim validation (`exp`, `iat`, `auth_time`,
      `aud`, `iss`, `sub` length bounds) is ported as a complete set, not
      "whatever the JWT crate validates by default" — several of these
      (`auth_time <= now`, the exact `iss` string, `sub` length ≤ 128) are
      this app's own added checks, not generic JWT-library defaults.

**Exit criteria:** every primitive above passes a golden-vector test suite
with 100% of the logic exercised without a live network dependency (per the
Milestone 1 mock-client requirement).

## Milestone 3 — Turso as the control database

- Port the schema from `docs/control_database.md` §2 verbatim: `owner_control`,
  `shares`, `schema_migrations`, and (per Milestone 0) keep `rate_limits` for
  the three scopes that stay gateway-side.
- **Verify, don't assume, that Turso's transaction semantics cover the three
  specific atomic operations this schema depends on:**
  - Share registration's idempotent insert-then-select
    (`docker/lua/txt/shares.lua`'s `M.register`).
  - `mark_deleting`'s conditional `UPDATE ... WHERE state = 'active' AND
    object_path_hash = :hash` — this exact WHERE clause was itself a bug fix
    during a prior security review (an earlier version could flip a row to
    `deleting` before verifying the path matched); the fix's correctness
    depends on the UPDATE and the read-back happening as one atomic unit,
    with no other writer able to interleave.
  - The rate limiter's `INSERT ... ON CONFLICT DO UPDATE SET count =
    count + 1` followed by a `SELECT` in the same transaction — a lost
    update here silently doubles a caller's effective budget.
  Write a concurrency test that fires N parallel requests at each of these
  three operations against a real Turso database (not a mock) and asserts
  the count/state is exactly what single-writer semantics predict, before
  trusting the port. Use Turso's **remote-only** connection mode
  specifically (confirmed during research to have the same synchronous,
  immediately-durable consistency as talking to rqlite's HTTP API today) —
  embedded replicas' `sync()`-interval staleness window is the wrong
  consistency model for this schema and must not be used here.
- Port the migration story: `txt/rqlite_schema.py`'s current-schema snapshot
  and `txt/rqlite_updater.py`'s numbered-migration runner become their Turso
  equivalents (the Python CLI can very likely keep talking to Turso directly
  via a Rust extension or Turso's own HTTP API from Python — decide this
  specifically, don't assume). `VACUUM` support on Turso is unconfirmed as
  of this writing; confirm it works (or find the equivalent) before porting
  `--update-rql`'s final `VACUUM` step and `--clean-db`'s unconditional
  vacuum-both behavior.
- **Accept and record the risk, don't bury it:** Turso's underlying engine
  (`tursodatabase/turso`, the Rust rewrite that now powers Turso Cloud) is
  pre-1.0 as of this research. That's a materially different risk profile
  than rqlite's SQLite-on-Raft, which is built on decades-hardened SQLite.
  Mitigate with the backup cadence in Milestone 6 and by keeping the
  Northflank/rqlite stack warm through Milestone 8's rollback window rather
  than a hard cutover.

**Security & edge-case checklist:**

- [ ] `owner_control`'s `singleton = 1` CHECK constraint, `shares.state`'s
      enum CHECK, and every `length(...) = N` CHECK from
      `docs/control_database.md` §2 are confirmed to actually reject bad
      writes on Turso, not silently accepted (SQLite-compatible ≠
      guaranteed-identical constraint enforcement on a from-scratch engine).
- [ ] Foreign keys (`ON DELETE CASCADE`/`RESTRICT` — used in the owner's
      SQLCipher schema, not this control schema, but confirm the control
      schema's own constraints too) behave identically.
- [ ] A Turso outage returns a clear error the gateway maps to `503`
      (`docs/auth.md` §4.1/§4.2's documented fail-closed behavior), never a
      500 that could be mistaken for success, and never a silent bypass of
      an auth or rate-limit check.

**Exit criteria:** the concurrency tests above pass against a real Turso
database; a from-empty provisioning flow (`--init-owner` equivalent) and a
migration-apply flow both work end to end.

## Milestone 4 — Port the HTTP surface, endpoint by endpoint

Port each endpoint, replay Milestone 1's golden fixtures against it, and add
the edge cases below before moving to the next endpoint — not all at once at
the end. The first five rows below live on the owner-only, IAM-gated
container (Milestone 0); the last row's container is still an open question
there — port it once that's resolved, not before.

| Endpoint | Source | Notes |
| --- | --- | --- |
| `GET /health/live`, `GET /health/ready` | `readiness.lua` | readiness must work before the first schema exists, exactly as documented, so the operator's first provisioning call can succeed |
| `GET /v1/owner-row` | new, replaces the raw `/operator/rqlite/` proxy | Milestone 0's decision — one hardcoded parameterized query, not a proxy |
| `POST /v1/keys` | `owner_keys.lua` | UID triple-check (Firebase, configured, row), ticket minting |
| `POST /v1/r2-token` | `owner_r2_credentials.lua` | ticket + proof verification, then the two-credential mint from Milestone 2 |
| `POST /v1/shares`, `DELETE /v1/shares` | `create_share.lua`, `delete_share.lua` | idempotent create; conditional-delete with the path-hash fix noted in Milestone 3 |
| `POST /v1/shared-url` | `shared_object_url.lua` | the one endpoint reachable with no Firebase/ticket credential at all — its container and abuse control are Milestone 0's open caller-2 question, not decided yet |

**Security & edge-case checklist, applied to every endpoint above:**

- [ ] Missing or mismatched `Origin` header → `403`, before any other work
      (including before touching Turso or R2) — port `request.lua`'s
      ordering, not just its outcome.
- [ ] Wrong HTTP method, and `OPTIONS` preflight handled without invoking
      the handler body.
- [ ] Oversized `Content-Length` rejected **before** reading the body
      (`request.lua`'s `M.json` checks this first specifically to avoid
      paying the cost of buffering an attacker-supplied giant body);
      confirm the chosen framework's body-limit middleware enforces this
      pre-read, not post-read.
- [ ] Malformed JSON, a JSON value that isn't an object, and a body that's
      valid JSON but missing required fields all produce the same
      documented `400`, not a framework-default error page that might leak
      implementation details.
- [ ] Every `db_path`/`db_prefix`/`share_prefix`/`share_path` is validated
      as exactly 52 lowercase base32-Crockford characters before use in any
      query or object key — port `owner_proof.lua`'s `valid_path` pattern
      exactly, including the alphabet.
- [ ] Expired tickets, expired proofs, and a proof `expires_at` beyond the
      60-second freshness window are all rejected with the documented
      status, tested with clock values right at the boundary (off-by-one on
      `<=` vs `<` matters here).
- [ ] A `share_id`/`grant` pair that decrypts but whose recovered path hash
      doesn't match the row's `object_path_hash` is rejected — this is the
      check that makes `docs/sharing.md` §8's "capability possession is the
      authorization" claim actually true; a regression here is a real
      information-disclosure bug, not a cosmetic one.
- [ ] Repeating `DELETE /v1/shares` on an already-`deleting` row is a no-op
      success, not an error (retry safety, per Milestone 3's path-hash fix).
- [ ] Concurrent duplicate `POST /v1/shares` with the same capability and
      path is idempotent; the same capability with a *different* path is
      rejected with `409`, exactly as `docs/sharing.md` §4.1 documents.
- [ ] No response ever includes a presigned URL, capability, or grant in a
      log line — `docs/sharing.md` §7's explicit prohibition — audit every
      `tracing`/log call added during this port for exactly this.

**Exit criteria:** every golden fixture from Milestone 1 passes; the
endpoint-specific checklist items above each have a named test.

## Milestone 5 — Abuse control

### Owner-scoped limits — settled by Milestone 0, build this now

Keep the three Turso-backed rate-limit scopes (`owner-keys`,
`owner-r2-token`, `owner-share-write`) in the gateway, ported directly from
`rate_limit.lua`'s atomic upsert-then-check, verified against Milestone 3's
concurrency tests. These run behind the private, IAM-gated container from
Milestone 0 — no Cloudflare involved.

Set Scaleway `max-scale` on that container deliberately, as the cost
backstop for the scenario Milestone 0 already named (a leaked unlock-file
secret): Scaleway's own autoscaling docs confirm `max-scale` is the only
native cost bound, and it fails closed (503) rather than open. Document the
chosen ceiling and the worst-case bill it implies even under that scenario.

### `public-share-url` — blocked on Milestone 0's open caller-2 decision

Nothing here can be finalized until Milestone 0's caller-2 question is
answered. Once it is, this milestone still needs, regardless of which
topology wins:

- A rate limit on this path matching (or deliberately revising, with a
  written reason) the current 120-requests-per-minute-per-peer budget,
  enforced by whichever layer ends up in front of it.
- A `max-scale` ceiling on whatever container serves it, sized independently
  from the owner-only container's — this path is reachable by anyone, so its
  worst-case cost model is different.
- If the answer involves an edge/CDN layer: confirm what client identity it
  rate-limits by *before* relying on it — this replaces `request.lua`'s
  explicit refusal to trust a spoofable `X-Forwarded-For` with an equivalent
  guarantee, and that guarantee has to be re-verified for whatever sits in
  front, not assumed.
- Confirm the `Origin` check still runs at the gateway regardless of any
  edge layer in front of it — an edge/CDN protects against volume, not
  against a same-origin-policy bypass from a malicious third-party page; the
  two checks are complementary, not redundant, whichever topology is chosen.

**Exit criteria:** owner-scoped limits pass Milestone 3's concurrency tests
under the private container; `public-share-url`'s abuse control is fully
specified and load-tested once Milestone 0's caller-2 decision lands, with
`max-scale` on both containers never reached during that test.

## Milestone 6 — Deployment pipeline

- Build a minimal Rust container image (distroless or `scratch`-based;
  the current OpenResty image is already minimal by comparison — don't
  regress that). Whether this is one image serving one namespace or two
  (owner-only private container, plus whatever caller 2 needs) depends on
  Milestone 0's still-open caller-2 decision; the steps below apply per
  container either way.
- Push to **Scaleway's own Container Registry**, not a directly-referenced
  external registry — Scaleway's own docs recommend against pulling
  directly from Docker Hub/GHCR/etc. in production ("uncontrolled rate
  limiting, unexpected failures").
- Configure the namespace's environment/secrets (Firebase project config,
  `R2_*`, `RATE_LIMIT_KEY`, `SHARE_GRANT_KEY`, `TURSO_DATABASE_URL`,
  `TURSO_AUTH_TOKEN`, `UI_ORIGIN`) — note these are namespace-level env vars
  today, not yet integrated with a dedicated secret manager on Scaleway;
  treat them with the same operational care `docs/deployment.md` §2
  describes for Northflank's equivalents.
- Tune the owner-only container's `min-scale` against the owner-unlock
  flow's latency sensitivity — a cold start on `/v1/keys` during the
  owner's own unlock is a worse regression than the equivalent cost of one
  warm instance, unlike the always-on Northflank container which never
  cold-starts at all today.
- Wire `/health/live` and `/health/ready` to Scaleway's own health-check
  configuration, preserving `readiness.lua`'s "works before the first
  schema exists" property from Milestone 4.
- Build the CI pipeline: build → `cargo test`/`clippy`/`audit` → push to
  registry → deploy, mirroring this repo's existing lint/test gates for the
  Python and TypeScript trees.
- Port `--init-owner`'s "install schema when empty" behavior and
  `--update-rql`'s "apply pending numbered migrations" behavior to Turso,
  including the migration-marker bookkeeping `docs/control_database.md` §4
  describes.

**Exit criteria:** a from-scratch deploy (empty Turso database, fresh
container) reaches a working, empty-but-ready state through the ported CLI
commands alone, with no manual database surgery.

## Milestone 7 — Load, chaos, and security testing

This is the "test carefully" milestone as its own dedicated pass, beyond the
per-endpoint checklists already threaded through Milestones 2–5.

- **Fuzz the parsers**, not just the happy path: malformed tickets, proofs,
  grants, and JWTs with truncated/extended/bit-flipped fields, run through
  the Milestone 2 primitives directly (fast, no HTTP needed) and through the
  full HTTP surface (confirms error mapping, not just the primitive).
- **Replay and cross-context reuse attempts**: a valid ticket replayed after
  its ticket's own expiry; a valid proof replayed a second time within its
  freshness window (should succeed twice today — confirm this is still
  intentional, since a proof isn't itself single-use, only the ticket-plus-
  proof combination is bounded by the proof's own short expiry); a grant
  decrypted under a different `share_id`; a presigned URL used after its
  60-second expiry; a temporary R2 credential used after its 15-minute
  expiry.
- **Concurrency races beyond Milestone 3's**: two browsers racing to create
  a share with the same capability but different paths; two racing
  `DELETE /v1/shares` calls on the same row; a `--clean-db`-equivalent
  maintenance run racing a live share creation.
- **Dependency and supply-chain checks**: `cargo audit`/`cargo deny` clean,
  pinned versions for every crate in the Milestone 2 table above (a crypto
  or SigV4 crate silently auto-upgrading to a version with different
  behavior is a real, quiet risk class for exactly this kind of gateway).
- **Fail-closed verification**: kill Turso mid-test and confirm every
  affected endpoint returns `503`, not a stale-success or a silent
  auth/rate-limit bypass; do the same for a simulated Firebase JWKS-fetch
  failure and a simulated R2 outage.
- **Re-run `docs/deployment.md` §7's entire release-verification checklist**
  against the new stack, item by item, as an explicit acceptance gate — it
  is the existing, working definition of "this deployment is safe to expose"
  and nothing in this migration should invalidate it.
- **Security review pass**: apply the `security-review` skill (or an
  equivalent independent read) to the full Rust gateway diff before
  Milestone 8, the same way this codebase's Lua/Python/TypeScript surfaces
  have been reviewed.

**Exit criteria:** every item above has a passing automated test where one
is feasible, and a written note where manual verification was necessary;
zero open findings from the security review pass.

## Milestone 8 — Parallel cutover

- Stand up the full new stack (Scaleway containers per Milestone 0's
  final topology + Turso) independently of the live Northflank/rqlite
  deployment, reachable at whatever origin(s) Milestone 0 settled on for
  callers 1 and 2 — separate from, and not yet linked to, production.
- Migrate (not copy-paste) the current rqlite control database into the new
  Turso database via a one-time export/import, then verify row-for-row
  parity (`owner_control`'s singleton row, every `shares` row's state and
  hashes) before any traffic moves.
- Run a canary: point only the maintainer's own owner unlock file at the new
  backend, exercise the full owner flow (unlock, read, write, bookmark,
  share create, share delete, share redemption from a real anonymous
  session) against production R2 data, for a deliberate soak period.
- Flip the UI's configured API origin(s) — `rqlite_db_url`/API base is
  confirmed in the "what does not change" section to be a pure runtime
  value, no UI rebuild required, but confirm whether the unlock file now
  needs to carry *two* origins (the owner-only container plus whatever
  caller 2 resolved to) or one, once Milestone 0 is closed out — for real
  users only after the canary soak is clean.
- Keep the Northflank/rqlite stack warm and reachable for a defined rollback
  window after the flip — not decommissioned — given Milestone 3's accepted
  pre-1.0-engine risk on Turso; a same-day rollback path must exist and be
  rehearsed once before it's needed for real.

**Exit criteria:** production traffic runs on the new stack for the full
rollback-window duration with no incident requiring the rollback path.

## Milestone 9 — Decommission and documentation

- Remove `docker/` (OpenResty config, Lua modules and tests, `Dockerfile`,
  `entrypoint.sh`, migrations) and `txt/rqlite_client.py`,
  `txt/rqlite_schema.py`, `txt/rqlite_updater.py`, once Milestone 8's
  rollback window has closed with no rollback used.
- Rewrite `docs/deployment.md` for Scaleway/Turso/Cloudflare, folding in
  this document's Milestone 0 topology as the new current-state design
  (and delete this milestones document once it describes a completed
  migration rather than a plan — `docs/*.md` describes current behavior
  only, per this repo's own documentation convention).
- Rewrite `docs/control_database.md` for Turso specifically: its schema
  section carries over, but §1 (service topology), §5 (availability), and
  §6 (backup/recovery) are Northflank/rqlite-specific and need real
  Turso-equivalent content, not a find-and-replace.
- Update every reference to rqlite, OpenResty, or Northflank in
  `docs/auth.md`, `docs/sharing.md`, `docs/storage_layout.md`, `CLAUDE.md`,
  and `README.md`.
- Remove the now-dead Lua test suite from CI and add the new Rust
  test/lint/audit gates to whatever this repo's CI configuration is at that
  point.

**Exit criteria:** no file in the repository still describes the Northflank/
OpenResty/Lua/rqlite stack as the current deployment; `git grep -i
'northflank\|openresty\|rqlite'` outside of git history returns nothing.

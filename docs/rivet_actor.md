# Rivet Actor Evaluation

This is an architecture option, not the current deployment. The implemented service remains the Cloudflare Worker in `worker/`.

## Recommendation

Do not replace the Worker with Rivet solely for the binding-ticket change. `/v1/r2-token` is intentionally stateless after ticket issuance, so putting each request in a new Actor would be the Actor-per-request anti-pattern called out by Rivet's [Crash Course](https://rivet.dev/docs/actors/crash-course/). Cloudflare already supplies the static-site origin, request routing, secrets, and the small KV cache/rate counters this service needs.

Rivet becomes attractive if the service is expected to grow per-account durable coordination: realtime sync, serialized writes, background ingestion, durable queues, or richer account state. In that case, use one Actor per account, never one Actor per request and never one global Actor.

## Viable Actor shape

An `account` Actor keyed by the Firebase uid (or a deterministic opaque derivation) can own:

- the same encrypted account-cache record currently stored at `keys:v3:{uid}`;
- keys/R2 rate-window counters;
- account-cache refresh timestamps and schema version;
- actions corresponding to `keys` and `r2Token`.

Do not persist `user_root_key`, raw `user_handle`, plaintext `umk`, the P-521 private key, `R2_TICKET_SECRET`, or the parent R2 secret in Actor state. The global signing secrets remain server environment secrets. The `r2Token` action still verifies the stateless ticket, raw-handle hash, path binding, and proof exactly as docs/auth.md specifies; moving runtimes must not weaken the protocol.

The Actor key is routing information, not authorization. Rivet documents credential validation in `onBeforeConnect` or `createConnState` and recommends using connection state inside actions ([Authentication](https://rivet.dev/docs/actors/authentication/)). The `keys` connection must verify Firebase and require the verified uid to match the account Actor. The `r2Token` path must verify the ticket and require its authenticated `sub` to match that Actor. Never trust a uid or role supplied as an action parameter.

## Durability and rate limiting

Rivet automatically persists `c.state`, including across sleep and restarts, but normal state saves are batched; the documented default interval is one second ([State](https://rivet.dev/docs/actors/state/)). Rivet also states that actions are not durable, while queues are durable and ordered ([Crash Course](https://rivet.dev/docs/actors/crash-course/)). Therefore:

- coarse abuse throttling may use ordinary Actor state and tolerate losing a few increments during a crash;
- a strict quota must serialize increments through a durable queue or transactional Actor SQLite rather than assuming an action response means the counter is durably committed;
- ticket expiry remains the security boundary and stays stateless; Actor sleep or eviction must not extend it.

Actors sleep when idle and restore state on demand; the current documented default sleep timeout is 30 seconds ([Lifecycle](https://rivet.dev/docs/actors/lifecycle/)). This fits an account cache, but it does not eliminate the first Turso lookup after actor creation or an explicit cache refresh.

## Migration cost

A replacement is not a package swap. It requires:

1. choosing Rivet Compute, self-hosting, or a serverless runner and managing `RIVET_ENDPOINT`/public connection configuration;
2. replacing the browser's same-origin REST calls with Rivet client calls, or preserving the REST contract through Actor `onRequest` plus a gateway;
3. preserving the static UI origin and R2 CORS policy after the Worker asset binding is removed;
4. reproducing Firebase verification, secret injection, response/status mapping, observability, and deployment rollback;
5. assigning runner versions before production and testing Actor-state migrations. Rivet warns that without versioning, old Actors can remain on old runners; see [Versions and Upgrades](https://rivet.dev/docs/actors/versions/).

If implemented, migrate in stages: keep the ticket wire format unchanged, build an account Actor behind the existing HTTP contract, shadow its authorization decisions without minting credentials, compare results and latency, then move cache/rate state, and only afterward switch traffic. This retains the current Worker as a rollback path and separates runtime risk from cryptographic-protocol risk.

## Decision trigger

Revisit Rivet when at least one durable per-account workload exists beyond caching and approximate rate limiting. Until then, the stateless Worker is the smaller trusted computing base and the simpler operational choice.

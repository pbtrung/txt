# Locally-verified boot (`local_index.html`)

`npm run build -- --admin-creds <path>` writes `creds/local_index.html` (never
`ui/dist/` — it's never uploaded to the CDN). Open that file directly (e.g. via
`file://`) instead of the deployed URL, and it cryptographically verifies every
built asset before ever rendering the Unlock screen — a spinner and a 5-line
progress list (`Fetching manifest` / `Verifying signature` / `Fetching assets` /
`Verifying asset hashes` / `Loading application`) track it.

This exists to fix a real gap in an earlier design this project tried: a verifier
that shipped as part of the same CDN-served bundle it was checking could simply be
tampered away by whatever compromised that CDN. `local_index.html` never touches
the CDN at all *except* to fetch and verify — it embeds its own public key and its
own copy of the verification logic (including a self-contained, inlined build of
[`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum)'s
`slh_dsa_sha2_256f` — no CDN/npm fetch at verify-time), generated once at build time
and then kept only on your machine, in `creds/` (gitignored, matching
`admin_creds.json`).

## At build time

`ui/scripts/build-integrity.mjs`:

- an SLH-DSA-SHA2-256f keypair is loaded from `admin_creds.json`'s
  `slhdsa_256f_priv_key` if present, or generated once (and written back there) if
  it's still empty — a rebuild never silently invalidates `local_index.html` copies
  already in use, since the key doesn't change unless you clear that field yourself;
- every file under `ui/dist/` is SHA-512'd into `dist/manifest.json`, signed with
  that key into `dist/manifest.sig`;
- `ui/dist/index.html`'s own `<script>`/`<link rel=stylesheet>` tags get
  `integrity="sha512-..."` (SRI, computed with Node's built-in `crypto`, no external
  package) added — this hardens the *separate* case of someone visiting the CDN URL
  directly, bypassing `local_index.html` entirely, against a MITM/cache swapping
  those two files while leaving `index.html` unchanged;
- `ui/dist/_headers` (Cloudflare Pages' response-header config file, also understood
  by Netlify and Cloudflare's Workers Static Assets) sets two things for every file
  under `ui/dist/`:
  - a real `Content-Security-Policy` header for the direct-CDN-visit case, mirroring
    `index.html`'s own `<meta>` CSP except `connect-src`, narrowed from that meta
    tag's deliberately-open `*` down to `'self'` plus the Turso/R2 host patterns the
    app actually talks to. A header and a `<meta>` CSP both apply at once and combine
    by intersection, so this tightens the effective policy without having to touch
    the per-account-agnostic meta tag itself;
  - `Access-Control-Allow-Origin: null`, so `local_index.html` (opened via `file://`,
    sending `Origin: null`) can actually read the response bodies of its cross-origin
    fetches to `manifest.json`/`manifest.sig`/every other asset — without it, those
    fetches resolve but the browser blocks reading the body (`... has been blocked by
    CORS policy: No 'Access-Control-Allow-Origin' header is present`).

  `_headers` is a deploy-time config file, never itself a fetchable path, so it's
  excluded from `manifest.json`/`local_index.html`'s own checks. This only takes
  effect if whatever serves `asset_base_url` actually reads a `_headers` file
  (Cloudflare Pages and Workers Static Assets do; a bucket served directly, with no
  such layer in front of it, does not — see [deployment.md](deployment.md)'s CORS
  section for that case).

## At open time

`local_index.html`:

1. fetches `{asset_base_url}/manifest.json` and `manifest.sig`, and verifies the
   signature over `manifest.json`'s exact bytes with the embedded public key —
   nothing is trusted before this passes;
2. fetches every file the now-trusted manifest lists and SHA-512s each one (native
   `crypto.subtle`, no external package) against its recorded digest;
3. once everything verifies, mounts the app directly from those already-verified
   bytes (an inlined `<style>`/`<script type="module">`) — it never re-fetches
   `index.html`/the entry JS/CSS a second time, since doing so would reopen the
   exact gap this exists to close.

## Known limitation

Only the entry JS/CSS get this full treatment. Fonts and
`leancrypto.js`/`leancrypto.wasm`/`brotli_wasm`'s own `.wasm` binary are still
hashed once during step 2 above, but the *running app* fetches them again live
later (via CSS `url()` and a dynamically created `<script src="/leancrypto.js">`)
without re-checking that later fetch against the manifest — a narrower version
of today's total absence of any check, not an airtight guarantee.
`vite.config.ts`'s `inlineDynamicImports: true` (see its own comment) closes
this gap for `brotli-wasm`'s browser build specifically — that used to be a
separately dynamic-imported JS chunk with this same problem, but its code is
now merged into the entry bundle itself, so it gets the full verify-then-mount
treatment along with everything else in it.

## Router

`history.pushState()`/`replaceState()` (which `BrowserRouter` needs for
every navigation) throws a `SecurityError` in a document with an opaque/null origin
— exactly `local_index.html`'s situation, since the real app's own bundle runs
unmodified inside it. `ui/src/appRouter.ts`'s `pickRouterComponent()` switches to
`MemoryRouter` (navigation kept entirely in JS, no `window.history` calls at all)
whenever a no-op `replaceState()` attempted in a try/catch actually throws. That's
deliberately empirical rather than checked via `location.protocol`/`location.origin`
— two attempts at guessing this from a string both turned out unreliable in
practice: `protocol === "file:"` misses Android, which commonly opens a local file
through a `content://` URI instead (e.g. a file manager's "Open with Chrome"), just
as opaque-origin as `file://` but a different protocol string; `origin === "null"`
*also* didn't catch that case on a real Android device, even though the resulting
SecurityError's own message still describes the origin as `'null'` — Chrome for
Android's `location.origin` for a `content://` document apparently doesn't reliably
serialize to that literal string the way `file://`'s does. Trying the actual
operation sidesteps needing to know how any given browser/scheme/platform
combination happens to report its origin. The probe URL matters too, and this took
a second empirical pass to get right: an early version used the full `location.href`
as a "harmless no-op" -- but that's an *absolute* URL, so the browser resolves it
without ever consulting `document.baseURI`, and comparing an opaque origin to itself
this way doesn't throw (confirmed empirically) even though a real (relative-path)
navigation from `BrowserRouter` absolutely would, once `render.ts` has pointed
`<base>` at `asset_base_url`. Using a path-absolute string instead
(`location.pathname` + `location.search` + `location.hash`, no scheme/host of its
own) forces resolution through `document.baseURI` the same way `BrowserRouter`'s own
calls do, so the probe fails exactly when they would -- confirmed against a real
`<base>`-pointed-elsewhere document -- while still being a true no-op on a normal
deployment (no `<base>` override to resolve against, so the probe reproduces
`location.href` exactly; confirmed the address bar is unchanged before/after).

**Accepted tradeoff**: `MemoryRouter` never touches `window.history`, so the address
bar won't reflect in-app navigation, and neither the browser's back/forward buttons
nor a mobile swipe-back gesture move between screens — both are tied to the real
history stack, which the app never adds anything to. This is a deliberate,
already-accepted cost of the opaque-origin bootstrap, not a bug.

**Requires**: opening `local_index.html` via `file://` sends `Origin: null` on its
cross-origin fetches to `asset_base_url`. `dist/_headers` (above) covers this
automatically when `asset_base_url` is served by Cloudflare Pages or Workers Static
Assets. If it instead points directly at an R2 bucket's public URL with nothing in
front of it, add `"null"` to that bucket's `AllowedOrigins` instead — see
[deployment.md](deployment.md)'s CORS section — either way, without one of these,
the fetches resolve but fail to read the response body.

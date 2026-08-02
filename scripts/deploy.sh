#!/bin/sh
# Runs `npm run deploy` (see root package.json). A plain npm script string
# can't route `npm run deploy -- creds.json` to the *middle* of a
# `ui:build && wrangler deploy` chain -- npm only ever appends trailing
# `--` args to the very end of the resolved command line (confirmed
# empirically: a script "a && b" invoked as `npm run script -- x` runs as
# "a && b x", not "a x && b"), so `creds.json` would land on `wrangler
# deploy` instead of `ui:build` -- (which is a build:creds config for
# build-integrity.mjs, not a Wrangler flag) -- exactly the bug this wrapper
# exists to avoid. A real script gets its own argv, so "$@" here means
# what it looks like it means.
set -e

# wrangler.jsonc's own "name" is a placeholder -- the real Worker name
# (must match whatever Worker resource this account already deployed, e.g.
# the one whose dashboard first surfaced "Variables cannot be added to a
# Worker that only has static assets") always comes from this env var
# instead, so a plain `wrangler deploy` (or `npm run deploy`) can never
# silently create/target the wrong Worker just because the committed
# placeholder was never updated.
if [ -z "$WORKER_NAME" ]; then
  echo "deploy.sh: WORKER_NAME env var is required (must match the existing Cloudflare Worker's name)" >&2
  exit 1
fi

npm run ui:build -- "$@"
wrangler deploy --name "$WORKER_NAME"

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
npm run ui:build -- "$@"
wrangler deploy

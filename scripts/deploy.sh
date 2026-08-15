#!/bin/sh
# wrangler.jsonc's own "name" is a placeholder -- the real Worker name
# (must match whatever Worker resource this account already deployed)
# always comes from this env var instead, so a plain `wrangler deploy`
# can never silently create/target the wrong Worker just because the
# committed placeholder was never updated.
set -e

if [ -z "$WORKER_NAME" ]; then
  echo "deploy.sh: WORKER_NAME env var is required (must match the existing Cloudflare Worker's name)" >&2
  exit 1
fi

wrangler deploy --name "$WORKER_NAME"

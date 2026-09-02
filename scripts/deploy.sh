#!/bin/sh
set -eu

if [ -z "${BUCKET_NAME:-}" ]; then
  echo "deploy.sh: BUCKET_NAME is required (the R2 bucket this Worker binds to)" >&2
  exit 1
fi

npm run ui:build

# wrangler.jsonc never commits the real bucket name -- substitute it into a
# throwaway copy rather than the tracked file.
config=$(mktemp /tmp/txt-wrangler-deploy.XXXXXX.jsonc)
trap 'rm -f "$config"' EXIT HUP INT TERM
sed "s/__BUCKET_NAME__/$BUCKET_NAME/" wrangler.jsonc > "$config"

npx wrangler deploy --config "$config"

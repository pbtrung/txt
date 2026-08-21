#!/bin/sh
set -eu

if [ -z "${WORKER_NAME:-}" ]; then
  echo "deploy.sh: WORKER_NAME is required (Cloudflare Pages project name)" >&2
  exit 1
fi

npm run ui:build
npx wrangler pages deploy dist --project-name "$WORKER_NAME"

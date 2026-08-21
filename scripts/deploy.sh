#!/bin/sh
set -eu

if [ -z "${CF_PROJECT_NAME:-}" ]; then
  echo "deploy.sh: CF_PROJECT_NAME is required (Cloudflare Pages project name)" >&2
  exit 1
fi

npm run ui:build
npx wrangler pages deploy dist --project-name "$CF_PROJECT_NAME"

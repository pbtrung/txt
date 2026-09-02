#!/bin/sh
set -eu

for var in BUCKET_NAME OWNER_EMAIL CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    echo "deploy.sh: $var is required" >&2
    exit 1
  fi
done

npm run ui:build

# wrangler.jsonc never commits these deployment-specific values -- substitute
# them into a throwaway copy rather than the tracked file.
config=$(mktemp /tmp/txt-wrangler-deploy.XXXXXX.jsonc)
trap 'rm -f "$config"' EXIT HUP INT TERM
sed \
  -e "s/replace-me-bucket-name/$BUCKET_NAME/" \
  -e "s/replace-me-owner-email/$OWNER_EMAIL/" \
  -e "s/replace-me-team-domain/$CF_ACCESS_TEAM_DOMAIN/" \
  -e "s/replace-me-access-aud/$CF_ACCESS_AUD/" \
  wrangler.jsonc > "$config"

npx wrangler deploy --config "$config"

echo "Remember: SHARE_GRANT_KEY and TICKET_SIGNING_KEY are set once via" >&2
echo "'wrangler secret put <NAME>', not by this script (docs/deployment.md)." >&2

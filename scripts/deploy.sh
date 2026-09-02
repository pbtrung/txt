#!/bin/sh
set -eu

for var in BUCKET_NAME OWNER_EMAIL CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD CF_ACCOUNT_ID; do
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
  -e "s/replace-me-account-id/$CF_ACCOUNT_ID/" \
  wrangler.jsonc > "$config"

npx wrangler deploy --config "$config"

echo "Remember: SHARE_GRANT_KEY, TICKET_SIGNING_KEY, R2_PARENT_API_TOKEN, and" >&2
echo "R2_PARENT_ACCESS_KEY_ID are set once via 'wrangler secret put <NAME>'," >&2
echo "not by this script (docs/deployment.md)." >&2

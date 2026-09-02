#!/bin/sh
set -eu

# Non-secret, deployment-specific values (docs/deployment.md §2) live in a
# gitignored JSON file rather than the shell environment -- default path is
# creds/deploy.json (creds/ is already gitignored), overridable with a
# first argument for a different deployment.
config_json=${1:-creds/deploy.json}
if [ ! -f "$config_json" ]; then
  echo "deploy.sh: $config_json not found" >&2
  echo "Create it with these keys (docs/deployment.md §2):" >&2
  echo '{"BUCKET_NAME": "...", "OWNER_EMAIL": "...", "CF_ACCESS_TEAM_DOMAIN": "...", "CF_ACCESS_AUD": "...", "CF_ACCOUNT_ID": "..."}' >&2
  exit 1
fi

for var in BUCKET_NAME OWNER_EMAIL CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD CF_ACCOUNT_ID; do
  value=$(jq -r --arg k "$var" '.[$k] // empty' "$config_json")
  if [ -z "$value" ]; then
    echo "deploy.sh: $var is missing or empty in $config_json" >&2
    exit 1
  fi
  eval "$var=\$value"
done

D1_DATABASE_NAME="txt-production"

# --- D1 (docs/deployment.md §1): resolve the production database, or
# create it if this is the first deploy. `wrangler d1 create` errors on a
# name that already exists, so list-then-create-then-list-again is the
# idempotent way to do this rather than treating a create error as
# "already exists" by guesswork.
find_database_id() {
  npx wrangler d1 list --json 2>/dev/null |
    jq -r --arg name "$D1_DATABASE_NAME" '.[] | select(.name == $name) | .uuid' |
    head -n1
}

echo "Checking for D1 database '$D1_DATABASE_NAME'..." >&2
DATABASE_ID=$(find_database_id)
if [ -z "$DATABASE_ID" ]; then
  echo "Creating D1 database '$D1_DATABASE_NAME'..." >&2
  npx wrangler d1 create "$D1_DATABASE_NAME"
  DATABASE_ID=$(find_database_id)
fi
if [ -z "$DATABASE_ID" ]; then
  echo "deploy.sh: could not resolve the D1 database id for '$D1_DATABASE_NAME'" >&2
  exit 1
fi
echo "D1 database '$D1_DATABASE_NAME' id=$DATABASE_ID" >&2

# --- R2 (docs/storage_layout.md): resolve or create the bucket. `r2
# bucket info` fails (nonzero exit) for a bucket that doesn't exist yet,
# which is all the idempotency check needs -- no id to resolve, the
# bucket name is already the identifier.
echo "Checking for R2 bucket '$BUCKET_NAME'..." >&2
if ! npx wrangler r2 bucket info "$BUCKET_NAME" >/dev/null 2>&1; then
  echo "Creating R2 bucket '$BUCKET_NAME'..." >&2
  npx wrangler r2 bucket create "$BUCKET_NAME"
fi

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
  -e "s/replace-me-database-id/$DATABASE_ID/" \
  wrangler.jsonc > "$config"

# Apply any pending D1 migrations (worker/migrations/) before deploying
# Worker code that expects the schema they add -- `wrangler deploy` does
# not do this on its own.
npx wrangler d1 migrations apply DB --remote --config "$config"

npm run ui:build

npx wrangler deploy --config "$config"

echo "Remember: SHARE_GRANT_KEY, TICKET_SIGNING_KEY, R2_PARENT_API_TOKEN, and" >&2
echo "R2_PARENT_ACCESS_KEY_ID are set once via 'wrangler secret put <NAME>'," >&2
echo "not by this script or $config_json (docs/deployment.md)." >&2
echo "wrangler has no Access-application support: create/verify the Access" >&2
echo "application gating /v1/* (Include: emails equals $OWNER_EMAIL, one" >&2
echo "bypass policy for POST /v1/shared-url) and R2 bucket CORS manually via" >&2
echo "the dashboard (docs/auth.md §2, docs/storage_layout.md) if not already" >&2
echo "done." >&2

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

# TESTING ONLY (docs/deployment.md §2, worker/api.ts's
# accessCheckSkipped()): set "SKIP_ACCESS_CHECK": true in $config_json to
# deploy with every /v1/* route reachable with no Access session at all,
# before an Access application exists yet. Defaults to false -- a
# creds/deploy.json without this key deploys exactly as before.
SKIP_ACCESS_CHECK=$(jq -r '.SKIP_ACCESS_CHECK // false' "$config_json")

CF_ACCESS_TEAM_DOMAIN=""
CF_ACCESS_AUD=""
required_vars="BUCKET_NAME OWNER_EMAIL CF_ACCOUNT_ID"
if [ "$SKIP_ACCESS_CHECK" != "true" ]; then
  required_vars="$required_vars CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD"
fi

for var in $required_vars; do
  value=$(jq -r --arg k "$var" '.[$k] // empty' "$config_json")
  if [ -z "$value" ]; then
    echo "deploy.sh: $var is missing or empty in $config_json" >&2
    exit 1
  fi
  eval "$var=\$value"
done

if [ "$SKIP_ACCESS_CHECK" = "true" ]; then
  echo "*** SKIP_ACCESS_CHECK is on: /v1/* will accept requests with NO" >&2
  echo "*** Access session at all. Testing only -- never leave this on for" >&2
  echo "*** a real deployment (docs/deployment.md §2)." >&2
fi

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
  # --update-config=false: this command defaults to rewriting wrangler.jsonc
  # in place with the new database's binding -- wrangler.jsonc's real
  # values only ever come from this script's own sed substitution below,
  # never from wrangler mutating the tracked file itself.
  npx wrangler d1 create "$D1_DATABASE_NAME" --update-config=false
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
  # --update-config=false: same reasoning as wrangler d1 create above.
  npx wrangler r2 bucket create "$BUCKET_NAME" --update-config=false
fi

# wrangler.jsonc never commits these deployment-specific values -- substitute
# them into a throwaway copy rather than the tracked file. CF_ACCESS_*
# stay as their committed "replace-me-*" placeholders when
# SKIP_ACCESS_CHECK is on, since that code path never reads them then.
sed_script="s/replace-me-bucket-name/$BUCKET_NAME/
s/replace-me-owner-email/$OWNER_EMAIL/
s/replace-me-account-id/$CF_ACCOUNT_ID/
s/replace-me-database-id/$DATABASE_ID/
s/\"database_name\": \"txt-dev\"/\"database_name\": \"$D1_DATABASE_NAME\"/"
if [ "$SKIP_ACCESS_CHECK" = "true" ]; then
  sed_script="$sed_script
s/\"SKIP_ACCESS_CHECK\": \"false\"/\"SKIP_ACCESS_CHECK\": \"true\"/"
else
  sed_script="$sed_script
s/replace-me-team-domain/$CF_ACCESS_TEAM_DOMAIN/
s/replace-me-access-aud/$CF_ACCESS_AUD/"
fi

# Created inside the repo root, not /tmp: wrangler.jsonc's relative paths
# (migrations_dir, main, assets.directory) resolve against the config
# file's own directory, so a --config file living somewhere else (e.g.
# /tmp) silently breaks them -- this is what caused migrations_dir to
# resolve to a nonexistent /tmp/worker/migrations the first time.
config=$(mktemp ./wrangler.deploy.XXXXXX.jsonc)
trap 'rm -f "$config"' EXIT HUP INT TERM
sed -e "$sed_script" wrangler.jsonc > "$config"

# Apply any pending D1 migrations (worker/migrations/) before deploying
# Worker code that expects the schema they add -- `wrangler deploy` does
# not do this on its own.
npx wrangler d1 migrations apply DB --remote --config "$config"

npm run ui:build

npx wrangler deploy --config "$config"

echo "Remember: SHARE_GRANT_KEY, TICKET_SIGNING_KEY, R2_PARENT_ACCESS_KEY_ID," >&2
echo "and R2_PARENT_SECRET_ACCESS_KEY are set once via 'wrangler secret put" >&2
echo "<NAME>', not by this script or $config_json (docs/deployment.md)." >&2
if [ "$SKIP_ACCESS_CHECK" = "true" ]; then
  echo "*** Deployed with SKIP_ACCESS_CHECK on: /v1/* has NO auth at all." >&2
  echo "*** Set up the Access application, then remove SKIP_ACCESS_CHECK" >&2
  echo "*** from $config_json and redeploy." >&2
else
  echo "wrangler has no Access-application support: create/verify the Access" >&2
  echo "application gating /v1/* (Include: emails equals $OWNER_EMAIL, one" >&2
  echo "bypass policy for POST /v1/shared-url) manually via the dashboard" >&2
  echo "(docs/auth.md §2) if not already done." >&2
fi
echo "R2 bucket CORS for the deployed UI origin also still needs the" >&2
echo "dashboard (docs/storage_layout.md)." >&2

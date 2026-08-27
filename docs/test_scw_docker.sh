#!/bin/sh
# Builds docs/Dockerfile.scw.test, tags it :latest, and pushes it to a
# Scaleway Container Registry namespace, per:
# https://www.scaleway.com/en/docs/serverless-containers/how-to/build-push-container-image/
#
# Usage: docs/test_scw_docker.sh <config.json>
# config.json: {"scw_registry_path": "rg.<region>.scw.cloud/<namespace>",
#               "scw_app_name": "<image-name>",
#               "scw_secret_key": "<api-secret-key>"}
set -eu

if [ -z "${1:-}" ]; then
  echo "test_scw_docker.sh: usage: test_scw_docker.sh <config.json>" >&2
  exit 1
fi
config="$1"
if [ ! -f "$config" ]; then
  echo "test_scw_docker.sh: no such file: $config" >&2
  exit 1
fi

eval "$(python3 - "$config" <<'PY'
import json
import shlex
import sys

with open(sys.argv[1]) as f:
    config = json.load(f)

required = ("scw_registry_path", "scw_app_name", "scw_secret_key")
missing = [key for key in required if not config.get(key)]
if missing:
    sys.exit(f"test_scw_docker.sh: config missing {', '.join(missing)}")

for key in required:
    print(f"{key}={shlex.quote(str(config[key]))}")
PY
)"

registry_host=${scw_registry_path%%/*}
image_ref="$scw_registry_path/$scw_app_name:latest"
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

echo "test_scw_docker.sh: building $image_ref" >&2
docker build -f "$repo_root/docs/Dockerfile.scw.test" -t "$image_ref" "$repo_root"

echo "test_scw_docker.sh: logging in to $registry_host" >&2
printf '%s' "$scw_secret_key" | docker login "$registry_host" -u nologin --password-stdin

echo "test_scw_docker.sh: pushing $image_ref" >&2
docker push "$image_ref"

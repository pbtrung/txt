#!/bin/sh
set -eu

require_pair() {
  first_name=$1
  first_value=$2
  second_name=$3
  second_value=$4
  if { [ -n "$first_value" ] && [ -z "$second_value" ]; } || \
    { [ -z "$first_value" ] && [ -n "$second_value" ]; }; then
    printf '%s and %s must be configured together\n' "$first_name" "$second_name" >&2
    exit 1
  fi
}

DATA_DIR=${DATA_DIR:-/rqlite/file/data}
NODE_ID=${NODE_ID:-txt-control-1}
HTTP_ADDR=${HTTP_ADDR:-127.0.0.1:14001}
HTTP_ADV_ADDR=${HTTP_ADV_ADDR:-127.0.0.1:14001}
RAFT_ADDR=${RAFT_ADDR:-0.0.0.0:4002}
RAFT_ADV_ADDR=${RAFT_ADV_ADDR:-127.0.0.1:4002}
RQLITE_ADMIN_HTPASSWD=${RQLITE_ADMIN_HTPASSWD:-/etc/nginx/rqlite-admin.htpasswd}
RQLITE_ADMIN_USERNAME=${RQLITE_ADMIN_USERNAME:-}
RQLITE_ADMIN_PASSWORD=${RQLITE_ADMIN_PASSWORD:-}
DNS_RESOLVER=${DNS_RESOLVER:-1.1.1.1}
UI_ORIGIN=${UI_ORIGIN:-}

while [ "${UI_ORIGIN%/}" != "$UI_ORIGIN" ]; do
  UI_ORIGIN=${UI_ORIGIN%/}
done

require_pair \
  RQLITE_ADMIN_USERNAME "$RQLITE_ADMIN_USERNAME" \
  RQLITE_ADMIN_PASSWORD "$RQLITE_ADMIN_PASSWORD"

if [ -z "$RQLITE_ADMIN_USERNAME" ]; then
  printf 'RQLITE_ADMIN_USERNAME and RQLITE_ADMIN_PASSWORD are required\n' >&2
  exit 1
fi

for value in "$RQLITE_ADMIN_USERNAME" "$RQLITE_ADMIN_PASSWORD"; do
  case "$value" in
    -*)
      printf 'RQLITE_ADMIN_USERNAME and RQLITE_ADMIN_PASSWORD must not start with -\n' >&2
      exit 1
      ;;
  esac
done

mkdir -p "$DATA_DIR" "$(dirname "$RQLITE_ADMIN_HTPASSWD")" \
  /tmp/client-body /tmp/proxy
chown -R rqlite:rqlite "$(dirname "$DATA_DIR")" /tmp/client-body /tmp/proxy
printf '%s' "$RQLITE_ADMIN_PASSWORD" | \
  htpasswd -iBc "$RQLITE_ADMIN_HTPASSWD" "$RQLITE_ADMIN_USERNAME"

rendered_nginx=/tmp/txt-nginx.conf
export DNS_RESOLVER RQLITE_ADMIN_HTPASSWD UI_ORIGIN
envsubst \
  '$DNS_RESOLVER $RQLITE_ADMIN_HTPASSWD $UI_ORIGIN' \
  </opt/txt/nginx.conf >"$rendered_nginx"
nginx -c "$rendered_nginx"

set -- \
  /usr/local/bin/rqlited \
  -node-id "$NODE_ID" \
  -http-addr "$HTTP_ADDR" \
  -http-adv-addr "$HTTP_ADV_ADDR" \
  -raft-addr "$RAFT_ADDR" \
  -raft-adv-addr "$RAFT_ADV_ADDR"

if [ -n "${RQLITE_BACKUP_CONF:-}" ]; then
  chown rqlite:rqlite "$RQLITE_BACKUP_CONF"
  set -- "$@" -auto-backup "$RQLITE_BACKUP_CONF"
fi

exec su-exec rqlite "$@" "$DATA_DIR"

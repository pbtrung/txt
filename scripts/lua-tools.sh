#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tools_dir=${LUA_TOOLS_DIR:-"$project_dir/.lua-tools"}
luacheck="$tools_dir/bin/luacheck"

install_luacheck() {
  if [ -x "$luacheck" ]; then return; fi
  luarocks --lua-version=5.1 install --tree "$tools_dir" luacheck 1.2.0-1
}

syntax_check() {
  bytecode=$(mktemp /tmp/txt-lua-bytecode.XXXXXX)
  trap 'rm -f "$bytecode"' EXIT HUP INT TERM
  find "$project_dir/docker/lua" -type f -name '*.lua' -print | sort | while IFS= read -r file; do
    luajit -b "$file" "$bytecode"
  done
  rm -f "$bytecode"
  trap - EXIT HUP INT TERM
}

case ${1:-check} in
format)
  "$project_dir/node_modules/.bin/stylua" "$project_dir/docker/lua"
  ;;
format-check)
  "$project_dir/node_modules/.bin/stylua" --check "$project_dir/docker/lua"
  ;;
lint)
  install_luacheck
  "$luacheck" "$project_dir/docker/lua"
  ;;
syntax)
  syntax_check
  ;;
test)
  luajit "$project_dir/docker/lua/tests/run.lua"
  ;;
check)
  sh "$0" format-check
  sh "$0" lint
  sh "$0" syntax
  sh "$0" test
  ;;
*)
  printf 'usage: %s {format|format-check|lint|syntax|test|check}\n' "$0" >&2
  exit 2
  ;;
esac

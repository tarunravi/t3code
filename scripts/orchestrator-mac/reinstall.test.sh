#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export T3_REINSTALL_LIBRARY_ONLY=1
source "$here/reinstall.sh"

installed="$tmp/T3 Code.app"
legacy_installed="$tmp/T3 Code (Orchestrator).app"

status=0
resolve_current_app >/dev/null || status=$?
[ "$status" -eq 1 ] || { echo "expected no-install status 1, got $status" >&2; exit 1; }

mkdir "$legacy_installed"
[ "$(resolve_current_app)" = "$legacy_installed" ] || { echo "legacy app was not selected" >&2; exit 1; }

mkdir "$installed"
status=0
resolve_current_app >/dev/null || status=$?
[ "$status" -eq 2 ] || { echo "expected dual-install status 2, got $status" >&2; exit 1; }

rmdir "$legacy_installed"
[ "$(resolve_current_app)" = "$installed" ] || { echo "renamed app was not selected" >&2; exit 1; }

rpc() {
  [ "$1" = launch ] || { echo "expected launch RPC" >&2; return 1; }
  shift
  local args=("$@")
  local expected=(--project-root "$HOME/Documents/brain" --title "T3 Code" --provider-instance codex \
    --model gpt-6-luna --message-file "$tmp/post install.md" --dry-run)
  [ "${#args[@]}" -eq "${#expected[@]}" ] || { echo "unexpected post-install launch args: ${args[*]}" >&2; return 1; }
  local i
  for i in "${!expected[@]}"; do
    [ "${args[$i]}" = "${expected[$i]}" ] || {
      echo "unexpected post-install launch args: ${args[*]}" >&2
      return 1
    }
  done
}
post_install_launch "$tmp/post install.md" --dry-run

echo "reinstall contracts: OK"

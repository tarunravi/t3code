#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export T3_REINSTALL_LIBRARY_ONLY=1
source "$here/reinstall.sh"

installed="$tmp/T3Code.app"
legacy_installed="$tmp/T3 Code.app"
older_installed="$tmp/T3 Code (Orchestrator).app"

status=0
resolve_current_app >/dev/null || status=$?
[ "$status" -eq 1 ] || { echo "expected no-install status 1, got $status" >&2; exit 1; }

mkdir "$older_installed"
[ "$(resolve_current_app)" = "$older_installed" ] || { echo "old Orchestrator app was not selected" >&2; exit 1; }

mkdir "$installed"
status=0
resolve_current_app >/dev/null || status=$?
[ "$status" -eq 2 ] || { echo "expected dual-install status 2, got $status" >&2; exit 1; }

rmdir "$older_installed"
rmdir "$installed"
mkdir "$legacy_installed"
[ "$(resolve_current_app)" = "$legacy_installed" ] || { echo "T3 Code app was not selected" >&2; exit 1; }
rmdir "$legacy_installed"
mkdir "$installed"
[ "$(resolve_current_app)" = "$installed" ] || { echo "T3Code app was not selected" >&2; exit 1; }

ps() {
  case "$2" in
    pid=,command=)
      printf '51 %s\n' "$installed/Contents/MacOS/T3Code"
      printf '52 /usr/bin/node --message %s\n' "$installed/Contents/MacOS/T3Code"
      printf '53 %s\n' "$installed/Contents/Frameworks/T3Code Helper.app/Contents/MacOS/T3Code Helper"
      ;;
    *) command ps "$@" ;;
  esac
}
lsof() {
  case "$3" in
    51) printf 'n%s\n' "$installed/Contents/MacOS/T3Code" ;;
    52) printf 'n/usr/bin/node\n' ;;
    53) printf 'n%s\n' "$installed/Contents/Frameworks/T3Code Helper.app/Contents/MacOS/T3Code Helper" ;;
  esac
}
[ "$(app_pids)" = $'51\n53' ] || { echo "PID selection did not confirm executable paths" >&2; exit 1; }

mkdir "$legacy_installed" "$older_installed"
status=0
resolve_current_app >/dev/null || status=$?
[ "$status" -eq 2 ] || { echo "expected ambiguous three-copy status 2, got $status" >&2; exit 1; }
rmdir "$legacy_installed" "$older_installed"

no_post_install=1
data_home="$tmp/data"
mkdir -p "$data_home/userdata"
app_pids() { :; }
[ -z "$(runtime_pid 2>/dev/null || true)" ] || { echo "runtime should be absent" >&2; exit 1; }
offline_reinstall_allowed || { echo "stopped app was not allowed offline" >&2; exit 1; }
node="$(command -v node)"
exclude_thread="excluded-id"
write_empty_active_threads "$tmp/active-threads.json"
node -e 'const s=require(process.argv[1]); if(s.origin!==null||s.excludedThreadId!=="excluded-id"||s.threads.length!==0) process.exit(1)' "$tmp/active-threads.json"
no_post_install=0
offline_reinstall_allowed && { echo "offline reinstall accepted without --no-post-install" >&2; exit 1; }
no_post_install=1
app_pids() { printf '4242\n'; }
offline_reinstall_allowed && { echo "offline reinstall accepted while app process exists" >&2; exit 1; }

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

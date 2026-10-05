#!/bin/bash
# Replaces the installed T3 Code (Orchestrator) with a freshly built app, from
# inside T3 itself. Quitting T3 kills every agent in it, so the swap runs as a
# one-shot launchd job outside T3's process tree.
#
#   reinstall.sh [--dry-run] [--new-app <App.app>] [--exclude-thread <id>] [--grace <s>]
#       Pre-flight, run by an agent inside T3: verifies the new app, records the
#       active threads, and submits the hand-off to launchd. Returns at once.
#       --dry-run uses a scratch dir, submits nothing, and then walks the
#       hand-off in dry-run mode, so every step is printed and nothing changes.
#   reinstall.sh --handoff <backup-dir> [--dry-run]
#       The detached hand-off (launchd runs this): back up the databases, quit
#       T3, swap the app, relaunch, wait for the server, and start a
#       post-install thread. Any failure after the swap rolls back.
#   reinstall.sh --cleanup <backup-dir> [--keep-backups N] [--dry-run]
#       Run by the post-install agent once verification passes.
#   reinstall.sh --rollback <backup-dir> [--dry-run]
#       Submits a detached job that restores the old app and the database
#       backups, then relaunches. Needs <backup-dir>/old, so run it before --cleanup.
#
# Environment: T3_DATA_HOME overrides the data home (default by machine).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app_name="T3 Code (Orchestrator)"
bundle_id="com.t3tools.t3code.orchestrator"
installed="/Applications/$app_name.app"
label="com.t3tools.t3code.reinstall"
work_mac="SGMD6RQH4RH6J"
work_team="5ZL939ZR9U"
uid="$(id -u)"

machine="$(scutil --get ComputerName 2>/dev/null || hostname)"
if [ "$machine" = "$work_mac" ]; then
  data_home="${T3_DATA_HOME:-$HOME/.t3-pr-2829}"
else
  data_home="${T3_DATA_HOME:-$HOME/.t3}"
fi

dry_run=0
mode=preflight
backup_dir=""
new_app="$HOME/t3-orchestrator-build/signed.noindex/$app_name.app"
exclude_thread=""
grace=20
keep_backups=2
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --new-app) new_app="$2"; shift ;;
    --exclude-thread) exclude_thread="$2"; shift ;;
    --grace) grace="$2"; shift ;;
    --handoff) mode=handoff; backup_dir="$2"; shift ;;
    --cleanup) mode=cleanup; backup_dir="$2"; shift ;;
    --rollback) mode=rollback; backup_dir="$2"; shift ;;
    --rollback-now) mode=rollback-now; backup_dir="$2"; shift ;;
    --keep-backups) keep_backups="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { log "ERROR: $*"; exit 1; }
# Prints the command; executes it unless --dry-run.
run() {
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    echo "  + $*"
    "$@"
  fi
}

find_node() {
  local candidate
  for candidate in "${T3_NODE:-}" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node \
    "$HOME/.cache/t3-bg-node/node-v24.13.1-darwin-arm64/bin/node"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] &&
      "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Verifies signature stability, and on the work Mac the Team ID and Santa rule.
verify_app() {
  local app="$1" details rule
  "$here/verify-signature.sh" "$app" "$bundle_id" || return 1
  if [ "$machine" = "$work_mac" ]; then
    details="$(codesign -dvv "$app" 2>&1)"
    case "$details" in
      *"TeamIdentifier=$work_team"*) ;;
      *) log "not signed by Team $work_team"; return 1 ;;
    esac
    rule="$(santactl fileinfo "$app/Contents/MacOS/$app_name" --key Rule 2>/dev/null || true)"
    case "$rule" in
      *"Allowed (TeamID)"*) ;;
      *) log "Santa rule is '$rule', expected Allowed (TeamID)"; return 1 ;;
    esac
  fi
}

app_version() { defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown; }

# PIDs of every process running from the installed app bundle. pgrep -f would
# need the parenthesised path escaped as a regex.
# shellcheck disable=SC2009
app_pids() { ps -axo pid=,command= | grep -F "$installed/Contents/" | grep -v grep | awk '{print $1}' || true; }

# The Electron main process: parent is launchd, executable has no arguments.
main_pid() {
  ps -axo pid=,ppid=,command= | awk -v exe="$installed/Contents/MacOS/$app_name" \
    '$2 == 1 { cmd = $0; sub(/^ *[0-9]+ +[0-9]+ +/, "", cmd); if (cmd == exe) { print $1; exit } }'
}

rpc() { "$node" "$here/t3-rpc.mjs" "$@" --app "$installed" --base-dir "$data_home"; }

runtime_pid() {
  "$node" -e 'try { console.log(require(process.argv[1]).pid) } catch { console.log("") }' \
    "$data_home/userdata/server-runtime.json"
}

wait_for_exit() {
  local seconds="$1" i=0
  while [ $i -lt "$seconds" ]; do
    [ -z "$(app_pids)" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# SIGTERM is T3's graceful quit path (DesktopLifecycle) and, unlike
# `osascript quit`, needs no Automation permission from a launchd job.
quit_t3() {
  local pid
  pid="$(main_pid)"
  if [ -z "$pid" ] && [ -z "$(app_pids)" ]; then
    log "T3 is not running"
    return 0
  fi
  log "quitting T3 (main pid ${pid:-none})"
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] kill -TERM ${pid:-<main pid>}; wait up to 90s; then kill -KILL leftovers"
    return 0
  fi
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  wait_for_exit 90 && { log "T3 exited"; return 0; }
  log "T3 still running after 90s; sending SIGKILL"
  # shellcheck disable=SC2046
  kill -KILL $(app_pids) 2>/dev/null || true
  wait_for_exit 15 && { log "T3 killed"; return 0; }
  return 1
}

wait_healthy() {
  local old_pid="$1" i=0 pid
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] wait up to 180s for a new server pid in server-runtime.json, then t3-rpc.mjs health"
    return 0
  fi
  while [ $i -lt 180 ]; do
    pid="$(runtime_pid)"
    if [ -n "$pid" ] && [ "$pid" != "$old_pid" ] && kill -0 "$pid" 2>/dev/null && rpc health 2>/dev/null; then
      return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}

notify() {
  [ "$dry_run" -eq 0 ] || return 0
  # Notifications need no Automation grant; failure is harmless.
  osascript -e "display notification \"$1\" with title \"T3 reinstall\"" >/dev/null 2>&1 || true
}

# Writes a one-shot launchd job that runs this script's copy in the backup dir
# with <mode-flag> <backup-dir>, logging to handoff.log. launchd, not T3, is
# its parent, so it survives T3 quitting.
write_job_plist() {
  local plist="$1" mode_flag="$2"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$backup_dir/bin/reinstall.sh</string>
    <string>$mode_flag</string>
    <string>$backup_dir</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$node"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>T3_DATA_HOME</key><string>$data_home</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>LaunchOnlyOnce</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$backup_dir/handoff.log</string>
  <key>StandardErrorPath</key><string>$backup_dir/handoff.log</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" >/dev/null || die "generated plist is invalid"
}

# Unloads a finished job with our label; refuses if one is still running.
clear_job() {
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    if launchctl print "gui/$uid/$label" 2>/dev/null | grep -q 'state = running'; then
      die "a hand-off ($label) is already running"
    fi
    log "removing finished hand-off job $label"
    run launchctl bootout "gui/$uid/$label"
  fi
}

# ---------------------------------------------------------------- pre-flight
preflight() {
  node="$(find_node)" || die "node >= 22 not found; set T3_NODE"
  log "machine $machine, data home $data_home, node $node"
  [ -d "$new_app" ] || die "new app not found: $new_app (build it with build.sh first)"
  # shellcheck disable=SC2009 # pgrep -f would treat the path as a regex
  if ps -axo command= | grep -F 'orchestrator-mac/build.sh' | grep -qv grep; then
    [ "$dry_run" -eq 1 ] || die "build.sh is still running; wait for it to finish"
    log "WARNING: build.sh is still running; a real run would stop here"
  fi
  [ -d "$installed" ] || die "nothing installed at $installed"
  [ -f "$data_home/userdata/server-runtime.json" ] || die "no server-runtime.json under $data_home"

  log "verifying new app $(app_version "$new_app") (installed: $(app_version "$installed"))"
  verify_app "$new_app" || die "new app failed verification; not installing it"

  rpc health || die "T3 server is not healthy; refusing to hand off"
  clear_job

  local ts dbs_kb free_kb
  ts="$(date +%Y%m%d-%H%M%S)"
  if [ "$dry_run" -eq 1 ]; then
    backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3-reinstall-dryrun-$ts.XXXX")"
  else
    backup_dir="$HOME/Backups/t3-reinstall-$ts"
    mkdir -p "$backup_dir"
  fi
  dbs_kb="$(du -ck "$data_home"/userdata/*.sqlite 2>/dev/null | awk 'END {print $1}')"
  free_kb="$(df -k "$HOME" | awk 'NR == 2 {print $4}')"
  [ "$free_kb" -gt $((dbs_kb + dbs_kb / 2 + 2000000)) ] ||
    die "need ~$((dbs_kb * 3 / 2 / 1024)) MB free for the backup, have $((free_kb / 1024)) MB"

  log "backup dir $backup_dir"
  touch "$backup_dir/.t3-reinstall"
  mkdir -p "$backup_dir/bin"
  cp "$here/reinstall.sh" "$here/t3-rpc.mjs" "$here/verify-signature.sh" "$backup_dir/bin/"
  {
    printf 'new_app=%q\n' "$new_app"
    printf 'node=%q\n' "$node"
    printf 'data_home=%q\n' "$data_home"
    printf 'grace=%q\n' "$grace"
    printf 'new_version=%q\n' "$(app_version "$new_app")"
    printf 'old_version=%q\n' "$(app_version "$installed")"
  } >"$backup_dir/handoff.env"

  log "recording active threads"
  if [ -n "$exclude_thread" ]; then
    rpc active-threads --out "$backup_dir/active-threads.json" --exclude "$exclude_thread"
  else
    rpc active-threads --out "$backup_dir/active-threads.json"
  fi

  cat >"$backup_dir/post-install-prompt.md" <<EOF
T3 Code was just reinstalled by the detached hand-off ($(app_version "$installed") -> $(app_version "$new_app")).
Run the **post-install phase** of the \`install-new-t3\` skill (~/Documents/brain/.agents/skills/install-new-t3/SKILL.md) with:

BACKUP_DIR=$backup_dir

The hand-off log is \$BACKUP_DIR/handoff.log and the threads to resume are in \$BACKUP_DIR/active-threads.json.
EOF

  write_job_plist "$backup_dir/handoff.plist" --handoff

  if [ "$dry_run" -eq 1 ]; then
    log "would submit: launchctl bootstrap gui/$uid $backup_dir/handoff.plist"
    log "walking the hand-off in dry-run mode"
    echo
    "$backup_dir/bin/reinstall.sh" --handoff "$backup_dir" --dry-run
    return 0
  fi
  launchctl bootstrap "gui/$uid" "$backup_dir/handoff.plist"
  log "hand-off submitted as $label; T3 quits in ~${grace}s. Follow it in $backup_dir/handoff.log"
}

# ------------------------------------------------------------------ hand-off
stage=none

rollback() {
  log "ROLLBACK from stage $stage"
  case "$stage" in
    moved | installed | launched) ;;
    *)
      # Nothing was swapped; bring the old app back if it was quit.
      if [ -z "$(app_pids)" ] && [ -d "$installed" ]; then run open "$installed"; fi
      return 0
      ;;
  esac
  if [ "$stage" = launched ]; then quit_t3 || log "could not quit the new app"; fi
  if [ -d "$installed" ]; then
    run mkdir -p "$backup_dir/failed-new"
    run mv "$installed" "$backup_dir/failed-new/"
  fi
  run mv "$backup_dir/old/$app_name.app" "$installed"
  if [ "$stage" = launched ]; then
    # The new build may have migrated the databases; the old one needs its copies.
    local db base
    run mkdir -p "$backup_dir/failed-db"
    for db in "$backup_dir"/db/*.sqlite; do
      [ -e "$db" ] || continue
      base="$(basename "$db")"
      for suffix in "" -wal -shm; do
        if [ -e "$data_home/userdata/$base$suffix" ]; then
          run mv "$data_home/userdata/$base$suffix" "$backup_dir/failed-db/"
        fi
      done
      run cp "$db" "$data_home/userdata/$base"
    done
  fi
  run open "$installed"
}

fail() {
  log "FAILED: $*"
  rollback || log "rollback hit an error; inspect $backup_dir"
  [ "$dry_run" -eq 1 ] || echo "failed: $*" >"$backup_dir/handoff.status"
  notify "Reinstall failed and was rolled back. See $backup_dir/handoff.log"
  exit 1
}

handoff() {
  [ -f "$backup_dir/.t3-reinstall" ] || die "$backup_dir is not a reinstall backup dir"
  local old_version="" new_version=""
  # shellcheck source=/dev/null # handoff.env is written by preflight
  . "$backup_dir/handoff.env"
  log "hand-off: $old_version -> $new_version on $machine (dry-run=$dry_run)"
  [ "$dry_run" -eq 1 ] || sleep "$grace" # lets the agent that started this finish its reply

  local old_pid db started
  old_pid="$(runtime_pid)"

  log "1/7 back up databases and settings while T3 is running"
  run mkdir -p "$backup_dir/db"
  for db in "$data_home"/userdata/*.sqlite; do
    [ -e "$db" ] || continue
    run sqlite3 "$db" "VACUUM INTO '$backup_dir/db/$(basename "$db")'" || fail "backup of $db"
  done
  for f in settings.json client-settings.json; do
    if [ -f "$data_home/userdata/$f" ]; then run cp "$data_home/userdata/$f" "$backup_dir/db/"; fi
  done

  log "2/7 quit T3"
  stage=quitting
  quit_t3 || fail "T3 did not quit"

  log "3/7 keep the old app for rollback"
  run mkdir -p "$backup_dir/old"
  run mv "$installed" "$backup_dir/old/" || fail "moving the old app"
  stage=moved

  log "4/7 install the new app"
  run ditto "$new_app" "$installed" || fail "ditto"
  stage=installed
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] verify-signature.sh + Team/Santa check on $installed"
  else
    verify_app "$installed" || fail "installed app failed verification"
  fi

  log "5/7 launch"
  started="$(date +%s)"
  run open "$installed" || fail "open"
  stage=launched

  log "6/7 wait for the server"
  wait_healthy "$old_pid" || fail "server not healthy within 180s"
  log "server healthy after $(($(date +%s) - started))s"
  stage=healthy

  log "7/7 start the post-install thread"
  if [ "$dry_run" -eq 1 ]; then
    rpc launch --project-root "$HOME/Documents/brain" --title "Post-install: T3 $new_version" \
      --message-file "$backup_dir/post-install-prompt.md" --dry-run || log "launch dry-run failed"
  elif ! rpc launch --project-root "$HOME/Documents/brain" --title "Post-install: T3 $new_version" \
    --message-file "$backup_dir/post-install-prompt.md"; then
    # The new app is healthy, so keep it; a person can start this phase by hand.
    log "could not start the post-install thread; start it manually with $backup_dir/post-install-prompt.md"
    echo "installed; post-install thread not started" >"$backup_dir/handoff.status"
    notify "T3 $new_version installed; start the post-install phase manually"
    exit 0
  fi
  [ "$dry_run" -eq 1 ] || echo "installed $new_version" >"$backup_dir/handoff.status"
  notify "T3 $new_version installed; post-install thread started"
  log "hand-off complete"
}

# ------------------------------------------------------------------- cleanup
cleanup() {
  [ -f "$backup_dir/.t3-reinstall" ] || die "$backup_dir is not a reinstall backup dir"
  local d n=0
  log "remove the rollback copy of the old app"
  if [ -d "$backup_dir/old" ]; then run rm -rf "$backup_dir/old"; fi
  if [ -d "$backup_dir/failed-new" ]; then run rm -rf "$backup_dir/failed-new"; fi

  log "remove stale staging dirs in /Applications"
  for d in /Applications/.t3-*-stage-*.noindex; do
    if [ -e "$d" ]; then run rm -rf "$d"; fi
  done

  log "remove leftover build scratch space (the signed app, logs, and BUILD-INFO stay)"
  # shellcheck disable=SC2009 # pgrep -f would treat the path as a regex
  if ps -axo command= | grep -F 'orchestrator-mac/build.sh' | grep -qv grep; then
    log "a build is running; leaving ~/t3-orchestrator-build alone"
  elif [ -d "$HOME/t3-orchestrator-build/work" ]; then
    run git -C "$HOME/t3code" worktree prune
    run rm -rf "$HOME/t3-orchestrator-build/work"
  fi

  log "keep the newest $keep_backups reinstall backups"
  # Only dirs this script created (marker file); newest first by name timestamp.
  for d in "$HOME"/Backups/t3-reinstall-*; do
    [ -f "$d/.t3-reinstall" ] && echo "$d"
  done | sort -r | while IFS= read -r d; do
    n=$((n + 1))
    if [ $n -gt "$keep_backups" ] && [ "$d" != "$backup_dir" ]; then run rm -rf "$d"; fi
  done

  log "unload the finished hand-off job"
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then run launchctl bootout "gui/$uid/$label"; fi
}

case "$mode" in
  preflight) preflight ;;
  handoff)
    node="${node:-$(find_node)}" || die "node not found"
    handoff
    ;;
  rollback)
    # Submitted detached: rolling back quits T3 and the agent asking for it.
    [ -f "$backup_dir/.t3-reinstall" ] || die "$backup_dir is not a reinstall backup dir"
    [ -d "$backup_dir/old/$app_name.app" ] || die "no old app in $backup_dir/old (already cleaned up?)"
    node="$(find_node)" || die "node not found"
    clear_job
    write_job_plist "$backup_dir/rollback.plist" --rollback-now
    if [ "$dry_run" -eq 1 ]; then
      log "would submit: launchctl bootstrap gui/$uid $backup_dir/rollback.plist"
      "$here/reinstall.sh" --rollback-now "$backup_dir" --dry-run
    else
      launchctl bootstrap "gui/$uid" "$backup_dir/rollback.plist"
      log "rollback submitted; T3 quits in ~${grace}s. Follow it in $backup_dir/handoff.log"
    fi
    ;;
  rollback-now)
    [ -f "$backup_dir/.t3-reinstall" ] || die "$backup_dir is not a reinstall backup dir"
    node="$(find_node)" || die "node not found"
    log "manual rollback requested"
    [ "$dry_run" -eq 1 ] || sleep "$grace"
    stage=launched
    rollback
    [ "$dry_run" -eq 1 ] || echo "rolled back by request" >"$backup_dir/handoff.status"
    notify "T3 rolled back to the previous build"
    ;;
  cleanup) cleanup ;;
esac

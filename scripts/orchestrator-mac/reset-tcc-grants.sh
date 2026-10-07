#!/usr/bin/env bash
# Removes stale Accessibility and Screen Recording rows for T3 builds so the
# installed app can be granted again.
#
#   scripts/orchestrator-mac/reset-tcc-grants.sh            # dry run
#   scripts/orchestrator-mac/reset-tcc-grants.sh --apply    # reset
#   scripts/orchestrator-mac/reset-tcc-grants.sh --apply com.example.id ...
#
# TCC stores each grant with the code requirement of the build that was
# granted. An ad hoc build's requirement is its cdhash, so after a rebuild
# tccd logs "Failed to match existing code requirement" and denies access
# while System Settings still shows the toggle on. Rows for retired bundle ids
# (com.t3tools.t3code from Alpha/ad hoc builds) linger the same way.
#
# Resetting revokes these grants for running apps too: quit T3 first, and
# re-grant afterwards in System Settings → Privacy & Security.
set -euo pipefail

apply=0
if [[ "${1:-}" == --apply ]]; then
  apply=1
  shift
fi
if [[ $# -gt 0 ]]; then
  bundle_ids=("$@")
else
  bundle_ids=(com.t3tools.t3code.orchestrator com.t3tools.t3code com.t3tools.t3code.dev)
fi
services=(Accessibility ScreenCapture)

failed=()
for bundle_id in "${bundle_ids[@]}"; do
  for service in "${services[@]}"; do
    if [[ $apply -eq 0 ]]; then
      echo "would run: tccutil reset $service $bundle_id"
    elif tccutil reset "$service" "$bundle_id"; then
      :
    else
      failed+=("$service $bundle_id")
    fi
  done
done

if [[ $apply -eq 0 ]]; then
  echo "dry run; pass --apply to reset (quit T3 first)"
  exit 0
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  # tccutil resolves bundle ids through LaunchServices, so it cannot reset an
  # id whose app is no longer on disk.
  echo "tccutil could not reset (app not on disk?):" >&2
  printf '  %s\n' "${failed[@]}" >&2
  echo "Remove those rows with the − button in System Settings → Privacy & Security." >&2
fi

echo "Now launch /Applications/T3 Code.app, trigger the feature, and grant:"
echo "  open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'"
echo "  open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'"

#!/usr/bin/env bash
# Verifies that an app's signature gives macOS privacy grants (TCC) a stable
# identity across rebuilds: valid, not ad hoc, and a designated requirement
# that names the bundle id and certificate rather than a cdhash.
#
#   scripts/orchestrator-mac/verify-signature.sh <App.app> [bundle-id]
set -euo pipefail

app="${1:?usage: $0 <App.app> [bundle-id]}"
bundle_id="${2:-com.t3tools.t3code.orchestrator}"
fail() { echo "FAIL: $*" >&2; exit 1; }

codesign --verify --deep --strict "$app" || fail "signature does not verify"

details="$(codesign -dvv "$app" 2>&1)"
grep -q '^Signature=adhoc' <<<"$details" && fail "ad hoc signature"
grep -q "^Identifier=$bundle_id\$" <<<"$details" || fail "identifier is not $bundle_id"

requirement="$(codesign -dr - "$app" 2>&1 | grep '^designated')"
grep -q cdhash <<<"$requirement" && fail "designated requirement pins a cdhash: $requirement"
grep -q "identifier \"$bundle_id\"" <<<"$requirement" || fail "requirement lacks the bundle id: $requirement"

echo "OK $app"
grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp)=' <<<"$details" || true
echo "$requirement"

if command -v santactl >/dev/null 2>&1; then
  santactl fileinfo "$app/Contents/MacOS/$(defaults read "$app/Contents/Info" CFBundleExecutable)" \
    --key Rule 2>/dev/null || true
fi

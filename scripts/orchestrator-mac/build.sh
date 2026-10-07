#!/usr/bin/env bash
# Builds and signs this fork as "T3 Code" for macOS.
#
#   scripts/orchestrator-mac/build.sh <output-dir>
#
# Environment:
#   T3_SIGNING_IDENTITY  required: SHA-1 or exact name of a code-signing identity
#                        in the keychain. Ad hoc ("-") is refused: an ad hoc
#                        designated requirement pins the cdhash, so every rebuild
#                        silently invalidates Accessibility/Screen Recording grants.
#   T3_ORCH_HOME         backend data home baked into the app (default ~/.t3-pr-2829)
#   T3_BUILD_VERSION     bundle version (default <package version>-fork.<sha10>)
#   T3_ARCH              arm64 (default) or x64
#   T3_KEEP_WORK=1       keep the scratch worktree and build stage
#
# The source tree is never modified: the identity overlay is applied in a
# scratch worktree of HEAD under <output-dir>/work.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

[[ $# -eq 1 ]] || die "usage: $0 <output-dir>"
[[ "$(uname -s)" == Darwin ]] || die "macOS only"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
case "$out/" in "$repo/"*) die "output dir must be outside the checkout" ;; esac

[[ -z "$(git -C "$repo" status --porcelain)" ]] || die "checkout has uncommitted changes; commit them first"

identity="${T3_SIGNING_IDENTITY:-}"
[[ -n "$identity" && "$identity" != "-" ]] || die "set T3_SIGNING_IDENTITY to a real code-signing identity; ad hoc signing is refused"
identities="$(security find-identity -v -p codesigning)"
grep -qF "$identity" <<<"$identities" || die "identity '$identity' is not a valid code-signing identity in the keychain:
$identities"

node_major_minor="$(node -p 'process.versions.node.split(".").slice(0,2).join(".")')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=13)?0:1)' \
  || die "node $node_major_minor is too old; put Node >=24.13 first on PATH"

sha="$(git -C "$repo" rev-parse HEAD)"
pkg_version="$(node -p "require('$repo/apps/desktop/package.json').version")"
version="${T3_BUILD_VERSION:-$pkg_version-fork.${sha:0:10}}"
arch="${T3_ARCH:-arm64}"
flavor="${T3_FLAVOR:-}"
if [[ -z "$flavor" ]]; then
  if [[ "${T3_ORCH:-0}" == 1 || -n "${T3_ORCH_HOME:-}" ]]; then
    flavor="orchestrator"
  elif [[ "$(scutil --get ComputerName 2>/dev/null || hostname)" == "SGMD6RQH4RH6J" ]]; then
    flavor="orchestrator"
  else
    flavor="normal"
  fi
fi

if [[ "$flavor" == "orchestrator" ]]; then
  app_name="T3 Code"
  bundle_id="com.t3tools.t3code.orchestrator"
  data_home="${T3_ORCH_HOME:-$HOME/.t3-pr-2829}"
  patch_file="$here/overlay.patch"
else
  app_name="T3 Code"
  bundle_id="com.t3tools.t3code"
  data_home="${T3_HOME:-$HOME/.t3}"
  patch_file="$here/normal-overlay.patch"
fi

work="$out/work"
src="$work/src"
log="$out/build.log"
rm -rf "$work"
mkdir -p "$work/tmp"
: >"$log"

cleanup() {
  if [[ "${T3_KEEP_WORK:-0}" != 1 ]]; then
    git -C "$repo" worktree remove --force "$src" >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
}
trap cleanup EXIT

echo "==> scratch worktree at $sha (flavor: $flavor)"
git -C "$repo" worktree add --detach "$src" "$sha" >>"$log" 2>&1
sed "s#__T3CODE_HOME__#$data_home#" "$patch_file" | git -C "$src" apply -

echo "==> pnpm install (log: $log)"
(cd "$src" && pnpm install --frozen-lockfile) >>"$log" 2>&1

echo "==> build desktop artifact $version ($arch)"
# A dedicated TMPDIR makes the retained stage easy to find.
(cd "$src" && PATH="$src/node_modules/.bin:$PATH" TMPDIR="$work/tmp" \
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch "$arch" \
  --keep-stage --build-version "$version" --output-dir "$work/artifacts") >>"$log" 2>&1

built="$(find "$work/tmp" -maxdepth 6 -type d -name "$app_name.app" -path '*/dist/mac*' | head -n 1)"
[[ -n "$built" ]] || die "no '$app_name.app' found in the build stage; see $log"

# .noindex keeps Spotlight and LaunchServices from registering a second copy
# next to the installed app.
dest_dir="$out/signed.noindex"
app="$dest_dir/$app_name.app"
rm -rf "$app"
mkdir -p "$dest_dir"
ditto "$built" "$app"

echo "==> sign with $identity"
osx_sign="$(find "$src/node_modules/.pnpm" -maxdepth 1 -type d -name '@electron+osx-sign@1.*' | sort -V | tail -n 1)"
[[ -n "$osx_sign" ]] || die "@electron/osx-sign 1.x not found in node_modules"
# osx-sign scans the working directory for provisioning profiles, so run it
# from scratch space rather than the checkout.
(cd "$work" && T3_OSX_SIGN_MODULE="$osx_sign/node_modules/@electron/osx-sign" \
  T3_SIGNING_IDENTITY="$identity" node "$here/sign-app.cjs" "$app") >>"$log" 2>&1

echo "==> verify"
"$here/verify-signature.sh" "$app" "$bundle_id"

cat >"$out/BUILD-INFO.txt" <<EOF
app: $app
flavor: $flavor
bundle_id: $bundle_id
version: $version
commit: $sha
identity: $identity
data_home: $data_home
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
$(codesign -dr - "$app" 2>&1 | grep designated)
EOF
echo "==> done: $app"

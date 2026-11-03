#!/usr/bin/env bash
# Builds and signs this fork as "T3Code" for macOS.
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
#   T3_NODE              existing Node executable matching engines.node
#   T3_PNPM_JS           existing JS pnpm entry point matching packageManager
#   T3_KEEP_WORK=1       keep the scratch worktree and build stage
#
# The source tree is never modified: the identity overlay is applied in a
# scratch worktree of HEAD under <output-dir>/work.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

configure_toolchain() {
  local bootstrap node_pin pnpm_pin candidate launcher_version host_arch
  bootstrap="${T3_NODE:-$(command -v node)}"
  node_pin="$("$bootstrap" -p 'require(process.argv[1]).engines.node' "$repo/package.json")"
  pnpm_pin="$("$bootstrap" -p 'require(process.argv[1]).packageManager' "$repo/package.json")"
  [[ "$node_pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$pnpm_pin" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "expected exact engines.node and packageManager pins"
  node=""
  case "$(uname -m)" in arm64) host_arch=arm64 ;; x86_64) host_arch=x64 ;; *) die "unsupported Mac architecture" ;; esac
  for candidate in "$bootstrap" "$HOME"/.cache/t3-upstream-toolchain-*/node-v"$node_pin"-darwin-"$host_arch"/bin/node; do
    [[ -x "$candidate" ]] || continue
    if [[ "$("$candidate" -p 'process.versions.node')" == "$node_pin" ]]; then
      node="$("$candidate" -p 'process.execPath')"
      break
    fi
    [[ -z "${T3_NODE:-}" ]] || die "T3_NODE must match engines.node=$node_pin"
  done
  [[ -n "$node" ]] || die "put existing Node $node_pin on PATH or set T3_NODE"
  export PATH="$(dirname "$node"):$PATH"
  pnpm_version="${pnpm_pin#pnpm@}"
  if [[ "$machine" == SGMD6RQH4RH6J || -n "${T3_PNPM_JS:-}" ]]; then
    export T3_PNPM_JS="${T3_PNPM_JS:-$HOME/.cache/node/corepack/v1/pnpm/$pnpm_version/bin/pnpm.mjs}"
    [[ -f "$T3_PNPM_JS" && "$T3_PNPM_JS" == /* ]] || die "T3_PNPM_JS must name an existing absolute JS entry point"
    case "$T3_PNPM_JS" in *.cjs|*.mjs|*.js) ;; *) die "T3_PNPM_JS must be JavaScript, not a native binary" ;; esac
    if grep -Eq 'native-binary|nativeBinary|pnpm[.-]native|@pnpm/exe' "$T3_PNPM_JS"; then
      die "cached pnpm entry dispatches a native binary; supply a verified JS pnpm $pnpm_version entry point (no security changes)"
    fi
    launcher_version="$("$node" "$T3_PNPM_JS" --version)"
  else
    launcher_version="$(pnpm --version)"
  fi
  [[ "$launcher_version" == "$pnpm_version" ]] || die "pnpm must match packageManager=$pnpm_pin (got $launcher_version)"
}

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

machine="$(scutil --get ComputerName 2>/dev/null || hostname)"
configure_toolchain

sha="$(git -C "$repo" rev-parse HEAD)"
pkg_version="$("$node" -p 'require(process.argv[1]).version' "$repo/apps/desktop/package.json")"
version="${T3_BUILD_VERSION:-$pkg_version-fork.${sha:0:10}}"
arch="${T3_ARCH:-arm64}"
flavor="${T3_FLAVOR:-}"
if [[ -z "$flavor" ]]; then
  if [[ "${T3_ORCH:-0}" == 1 || -n "${T3_ORCH_HOME:-}" ]]; then
    flavor="orchestrator"
  elif [[ "$machine" == "SGMD6RQH4RH6J" ]]; then
    flavor="orchestrator"
  else
    flavor="normal"
  fi
fi

if [[ "$flavor" == "orchestrator" ]]; then
  app_name="T3Code"
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
mkdir -p "$work/bin"
stage_tmp="$(mktemp -d "/private/tmp/t3code-mac-build.XXXXXX")"
: >"$log"

cleanup() {
  if [[ "${T3_KEEP_WORK:-0}" != 1 ]]; then
    git -C "$repo" worktree remove --force "$src" >/dev/null 2>&1 || true
    rm -rf "$work"
    rm -rf "$stage_tmp"
  fi
}
trap cleanup EXIT

if [[ -n "${T3_PNPM_JS:-}" ]]; then
  printf '#!/bin/bash\nexec %q %q "$@"\n' "$node" "$T3_PNPM_JS" >"$work/bin/pnpm"
  chmod +x "$work/bin/pnpm"
fi
export PATH="$work/bin:$PATH"

echo "==> scratch worktree at $sha (flavor: $flavor)"
git -C "$repo" worktree add --detach "$src" "$sha" >>"$log" 2>&1
sed "s#__T3CODE_HOME__#$data_home#" "$patch_file" | git -C "$src" apply -

echo "==> pnpm install (log: $log)"
(cd "$src" && pnpm install --frozen-lockfile) >>"$log" 2>&1

echo "==> build desktop artifact $version ($arch)"
# Keep probes outside HOME so ~/node_modules cannot satisfy missing packaged imports.
(cd "$src" && PATH="$work/bin:$src/node_modules/.bin:$PATH" TMPDIR="$stage_tmp" \
  T3CODE_DESKTOP_DEFER_MAC_VALIDATION=1 \
  "$node" scripts/build-desktop-artifact.ts --platform mac --target dir --arch "$arch" \
  --keep-stage --build-version "$version" --output-dir "$work/artifacts") >>"$log" 2>&1

built="$(find "$stage_tmp" -maxdepth 6 -type d -name "$app_name.app" -path '*/dist/mac*' | head -n 1)"
[[ -n "$built" ]] || die "no '$app_name.app' found in the build stage; see $log"

# .noindex keeps Spotlight and LaunchServices from registering a second copy
# next to the installed app.
dest_dir="$out/signed.noindex"
app="$dest_dir/$app_name.app"
rm -f "$out/BUILD-INFO.txt"
rm -rf "$app"
mkdir -p "$dest_dir"
ditto "$built" "$app"
display_name="$(defaults read "$app/Contents/Info" CFBundleDisplayName 2>/dev/null || true)"
[[ "$display_name" == "$app_name" ]] || die "expected CFBundleDisplayName '$app_name', got '${display_name:-<missing>}'"
app_home="$(/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:T3CODE_HOME' "$app/Contents/Info.plist" 2>/dev/null || true)"
[[ "$app_home" == "$data_home" ]] || die "expected T3CODE_HOME '$data_home', got '${app_home:-<missing>}'"
auto_update="$(/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:T3CODE_DISABLE_AUTO_UPDATE' "$app/Contents/Info.plist" 2>/dev/null || true)"
[[ "$auto_update" == true ]] || die "expected T3CODE_DISABLE_AUTO_UPDATE=true, got '${auto_update:-<missing>}'"

echo "==> sign with $identity"
osx_sign="$(find "$src/node_modules/.pnpm" -maxdepth 1 -type d -name '@electron+osx-sign@1.*' | sort -V | tail -n 1)"
[[ -n "$osx_sign" ]] || die "@electron/osx-sign 1.x not found in node_modules"
# osx-sign scans the working directory for provisioning profiles, so run it
# from scratch space rather than the checkout.
sign_app() {
  (cd "$work" && T3_OSX_SIGN_MODULE="$osx_sign/node_modules/@electron/osx-sign" \
    T3_SIGNING_IDENTITY="$identity" "$node" "$here/sign-app.cjs" "$app") >>"$log" 2>&1
}
sign_app

echo "==> verify before running packaged Electron"
"$here/verify-signature.sh" "$app" "$bundle_id" | tee -a "$log"
TMPDIR="$stage_tmp" "$node" "$here/../prepare-server-compile-cache.cjs" "$app" "$bundle_id" "$arch" >>"$log" 2>&1

# Cache generation changes sealed resources; reseal before any further validation.
echo "==> reseal generated compile cache"
sign_app
"$here/verify-signature.sh" "$app" "$bundle_id" | tee -a "$log"
TMPDIR="$stage_tmp" "$node" "$src/scripts/build-desktop-artifact.ts" --validate-mac-app "$app" "$bundle_id" >>"$log" 2>&1

echo "==> verify final signature"
"$here/verify-signature.sh" "$app" "$bundle_id" | tee -a "$log"

cat >"$out/BUILD-INFO.txt" <<EOF
app: $app
flavor: $flavor
bundle_id: $bundle_id
version: $version
commit: $sha
identity: $identity
data_home: $data_home
node: $("$node" --version)
pnpm: $pnpm_version (${T3_PNPM_JS:-PATH})
stage_tmp: $stage_tmp
validation: signed-cache-generation, resealed-signature, isolated-payload, final-signature
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
$(codesign -dr - "$app" 2>&1 | grep designated)
EOF
echo "==> done: $app"

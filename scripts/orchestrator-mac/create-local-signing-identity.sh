#!/usr/bin/env bash
# Creates a self-signed code-signing identity for Macs without a Developer ID
# certificate. Create it once and sign every build with it: the designated
# requirement then names this certificate, not a cdhash, so privacy grants
# survive rebuilds.
#
#   scripts/orchestrator-mac/create-local-signing-identity.sh ["T3 Local Code Signing"]
#
# T3_KEYCHAIN selects the keychain (default: login). macOS asks for your
# password to trust the certificate for code signing. Do not use this on a
# Mac whose policy (for example Santa) requires an approved team identity.
set -euo pipefail

name="${1:-T3 Local Code Signing}"
keychain="${T3_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if security find-certificate -c "$name" "$keychain" >/dev/null 2>&1; then
  echo "A certificate named '$name' already exists in $keychain; reusing it."
  security find-identity -p codesigning "$keychain" | grep -F "\"$name\"" || true
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
password="$(openssl rand -hex 16)"

cat >"$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -config "$tmp/cert.cnf" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
# -legacy keeps the PKCS#12 readable by `security` under OpenSSL 3; LibreSSL
# (the macOS default) has no such flag and already writes the old format.
legacy=()
openssl pkcs12 -help 2>&1 | grep -q -- '-legacy' && legacy=(-legacy)
openssl pkcs12 -export "${legacy[@]}" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -name "$name" -out "$tmp/identity.p12" -passout "pass:$password"

security import "$tmp/identity.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$tmp/cert.pem"

sha1="$(openssl x509 -in "$tmp/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
echo "Created '$name' ($sha1). Build with:"
echo "  T3_SIGNING_IDENTITY=$sha1 scripts/orchestrator-mac/build.sh <output-dir>"

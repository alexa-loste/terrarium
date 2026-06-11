#!/usr/bin/env bash
# Terrarium deploy — push backend (Convex cloud) + frontend (Netlify), from ANY machine that
# has the repo + node_modules + .env.local + .env.deploy.local. Designed so editing does NOT
# depend on the Mac Mini (the Mini is only the agents' runtime brain, not a build box).
#
# Usage:  bash scripts/deploy.sh [--backend-only | --frontend-only]
#
# Requires (all gitignored, set up once per machine):
#   .env.local        — VITE_CONVEX_URL, CONVEX_DEPLOYMENT, VITE_APP_PASSWORD
#   .env.deploy.local — NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID
#   ~/.convex/config.json — Convex account auth
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

# Some networks (cafe/corp wifi) do TLS inspection with a CA that's in the macOS keychain but
# not in node's bundled list, which breaks `convex` with "unable to get local issuer
# certificate". Regenerate a CA bundle from the keychain each run and point node at it.
CA="$HOME/.terrarium-ca.pem"
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > "$CA" 2>/dev/null || true
security find-certificate -a -p /Library/Keychains/System.keychain >> "$CA" 2>/dev/null || true
security find-certificate -a -p "$HOME/Library/Keychains/login.keychain-db" >> "$CA" 2>/dev/null || true
export NODE_EXTRA_CA_CERTS="$CA"

[ -f .env.deploy.local ] && source .env.deploy.local

MODE="${1:-all}"

if [ "$MODE" != "--frontend-only" ]; then
  echo "▶ Pushing backend to Convex cloud…"
  npx convex dev --once
fi

if [ "$MODE" != "--backend-only" ]; then
  echo "▶ Building frontend (bakes in VITE_CONVEX_URL + password)…"
  npx vite build
  echo "▶ Deploying to Netlify…"
  npx netlify deploy --prod --dir=dist --site "${NETLIFY_SITE_ID:?set NETLIFY_SITE_ID in .env.deploy.local}"
fi

echo "✅ Done."

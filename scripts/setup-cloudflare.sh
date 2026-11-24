#!/usr/bin/env bash
# One-time setup of Cloudflare resources in the TARGET account.
# Uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID if set, otherwise your `wrangler login`.
# Always check `npx wrangler whoami` first so you do not create resources in the wrong account.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Target account =="
npx wrangler whoami
read -r -p "Create resources in this account? [y/N] " ok
[ "$ok" = "y" ] || exit 1

echo "== D1 database =="
out=$(npx wrangler d1 create vehicle-photos 2>&1 || true)
echo "$out"
id=$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
if [ -n "${id:-}" ]; then
  sed -i.bak "s/00000000-0000-0000-0000-000000000000/$id/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "D1 database_id set to $id in wrangler.jsonc (also save it as the D1_DATABASE_ID GitHub secret)."
else
  echo "Could not read the database id (already exists?). Get it with: npx wrangler d1 list"
fi

echo "== R2 bucket (image cache) =="
npx wrangler r2 bucket create vehicle-photos-cache || true

echo "== Secrets (you will be prompted for each value) =="
for s in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET TOKEN_ENC_KEY SETUP_TOKEN; do
  echo "-> $s"
  npx wrangler secret put "$s"
done
echo "Optional later: npx wrangler secret put GOOGLE_VISION_API_KEY / AIFORTHAI_API_KEY / PUBLIC_BASE_URL"

echo "== Migrate + deploy =="
npx vite build
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy

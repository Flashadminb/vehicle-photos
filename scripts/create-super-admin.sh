#!/usr/bin/env bash
# Creates the first Super Admin on a fresh deployment (works only while no users exist).
# Usage: scripts/create-super-admin.sh https://your-worker.workers.dev
set -euo pipefail
URL="${1:?Base URL required}"
read -r -p "Setup token (SETUP_TOKEN secret): " TOKEN
read -r -p "Username: " USERNAME
read -r -p "Display name: " NAME
read -r -s -p "Password (8+ chars): " PASSWORD; echo
curl -fsS -X POST "$URL/api/setup" -H 'Content-Type: application/json' \
  --data "$(printf '{"token":"%s","username":"%s","displayName":"%s","password":"%s"}' "$TOKEN" "$USERNAME" "$NAME" "$PASSWORD")"
echo
echo "Done. Sign in at $URL/admin/"

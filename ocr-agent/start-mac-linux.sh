#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "ต้องติดตั้ง Node.js ก่อน: https://nodejs.org (LTS)"; exit 1; }
npm install --omit=dev --no-audit --no-fund --loglevel=error
while true; do node agent.mjs; echo "โปรแกรมหยุด จะเริ่มใหม่ใน 10 วินาที"; sleep 10; done

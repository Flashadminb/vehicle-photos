#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "ต้องติดตั้ง Node.js ก่อน: https://nodejs.org (LTS)"; exit 1; }
[ -f config.json ] || { echo "ยังไม่มี config.json — คัดลอก config.example.json แล้วใส่ token"; exit 1; }
[ -d node_modules ] || npm install --omit=dev
while true; do node agent.mjs; echo "โปรแกรมหยุด จะเริ่มใหม่ใน 10 วินาที"; sleep 10; done

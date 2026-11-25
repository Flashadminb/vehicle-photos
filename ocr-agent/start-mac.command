#!/bin/bash
# Vehicle Photos — Local OCR for macOS. Double-click this file in Finder.
# (First time: if macOS blocks it, right-click the file → Open → Open.)
cd "$(dirname "$0")" || exit 1
printf '\e]0;Vehicle Photos - Local OCR\a'

if [ ! -f agent.mjs ]; then
  echo "กรุณาแตกไฟล์ zip ก่อน (ดับเบิลคลิกไฟล์ zip) แล้วเปิด start-mac.command ในโฟลเดอร์ที่ได้"
  read -r -p "กด Enter เพื่อปิด"; exit 1
fi

# Node.js from the installer lives in /usr/local/bin; Homebrew on Apple Silicon in /opt/homebrew/bin.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "ยังไม่มี Node.js - กำลังติดตั้งด้วย Homebrew..."
    brew install node
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ยังไม่มี Node.js — กำลังเปิดหน้าดาวน์โหลด ให้ติดตั้งแบบ LTS (.pkg) แล้วดับเบิลคลิกไฟล์นี้ใหม่"
  open "https://nodejs.org/"
  read -r -p "กด Enter เพื่อปิด"; exit 1
fi

echo "กำลังตรวจสอบ/อัปเดตส่วนประกอบ (ครั้งแรก 1-3 นาที)..."
npm install --omit=dev --no-audit --no-fund --loglevel=error

# caffeinate keeps the Mac awake (not the screen) while the program runs.
while true; do
  caffeinate -i node agent.mjs
  echo "โปรแกรมหยุด จะเริ่มใหม่ใน 10 วินาที (ปิดหน้าต่างนี้เพื่อออก)"
  sleep 10
done

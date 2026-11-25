@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo ต้องติดตั้ง Node.js ก่อน: https://nodejs.org ^(เลือก LTS^) & pause & exit /b 1)
if not exist config.json (echo ยังไม่มี config.json - คัดลอก config.example.json แล้วใส่ token & pause & exit /b 1)
if not exist node_modules (echo กำลังติดตั้งครั้งแรก... & call npm install --omit=dev)
:loop
node agent.mjs
echo โปรแกรมหยุด จะเริ่มใหม่ใน 10 วินาที (กด Ctrl+C เพื่อออก)
timeout /t 10 >nul
goto loop

@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo ต้องติดตั้ง Node.js ก่อน: https://nodejs.org ^(เลือก LTS^) & pause & exit /b 1)
echo กำลังตรวจสอบ/อัปเดตส่วนประกอบ...
call npm install --omit=dev --no-audit --no-fund --loglevel=error
:loop
node agent.mjs
echo โปรแกรมหยุด จะเริ่มใหม่ใน 10 วินาที (กด Ctrl+C เพื่อออก)
timeout /t 10 >nul
goto loop

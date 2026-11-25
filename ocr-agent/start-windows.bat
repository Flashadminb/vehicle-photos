@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Vehicle Photos - Local OCR

rem Opened straight from inside the zip: Windows copies only this file to a temp folder.
if not exist "%~dp0agent.mjs" (
  echo.
  echo  กรุณาแตกไฟล์ zip ก่อน: คลิกขวาที่ไฟล์ zip แล้วเลือก Extract All
  echo  จากนั้นเปิด start-windows.bat ในโฟลเดอร์ที่แตกไฟล์แล้ว
  echo  ^(Please extract the zip first: right-click, Extract All^)
  echo.
  pause
  exit /b 1
)

rem Node.js missing: install it automatically with winget ^(Windows 10/11^).
where node >nul 2>nul
if errorlevel 1 (
  echo ยังไม่มี Node.js - กำลังติดตั้งให้อัตโนมัติ ^(ถ้า Windows ถาม ให้กด Yes^)...
  where winget >nul 2>nul
  if not errorlevel 1 winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo ติดตั้ง Node.js อัตโนมัติไม่สำเร็จ - ให้ติดตั้งเองจาก https://nodejs.org ^(ปุ่ม LTS^) แล้วเปิดไฟล์นี้ใหม่
  start https://nodejs.org
  pause
  exit /b 1
)

echo กำลังตรวจสอบ/อัปเดตส่วนประกอบ ^(ครั้งแรก 1-3 นาที^)...
call npm install --omit=dev --no-audit --no-fund --loglevel=error

:loop
node agent.mjs
echo โปรแกรมหยุด จะเริ่มใหม่ใน 10 วินาที ^(กด Ctrl+C เพื่อออก^)
timeout /t 10 >nul
goto loop

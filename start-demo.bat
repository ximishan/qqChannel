@echo off
cd /d %~dp0
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
call npx playwright install chromium
call npm start

@echo off
chcp 65001 >nul
title בשורה התחתונה - עבודה
cd /d "%~dp0"
pm2 start ecosystem.config.cjs
pm2 save
echo.
echo האפליקציה רצה. פתח דפדפן בכתובת http://localhost:5173
pause

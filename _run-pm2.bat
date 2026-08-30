@echo off
title בשורה התחתונה - עבודה
cd /d "%~dp0"
pm2 start ecosystem.config.cjs
pm2 save
echo.
echo האפליקציה רצה. פתח דפדפן בכתובת http://localhost:5174
pause

@echo off
title רישום הפעלה אוטומטית - בשורה התחתונה עבודה
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-autostart-task.ps1"
echo.
echo מעכשיו האפליקציה תעלה אוטומטית באתחול, בכניסה, ובהתעוררות ממצב שינה.
pause

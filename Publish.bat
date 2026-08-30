@echo off
chcp 65001 >nul
title פרסום גרסה - בשורה התחתונה עבודה
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1"
echo.
pause

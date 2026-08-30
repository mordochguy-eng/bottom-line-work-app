$Host.UI.RawUI.WindowTitle = "בשורה התחתונה - עבודה"
Set-Location -Path (Split-Path -Parent $PSScriptRoot)

pm2 start ecosystem.config.cjs
pm2 save

Write-Host ""
Write-Host "האפליקציה רצה. פתח דפדפן בכתובת http://localhost:5174" -ForegroundColor Green
Write-Host ""
Write-Host "לחץ מקש כלשהו כדי לסגור את החלון..." -ForegroundColor Gray
$null = [System.Console]::ReadKey($true)

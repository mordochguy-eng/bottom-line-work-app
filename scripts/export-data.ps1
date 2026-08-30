$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "ייצוא נתונים - בשורה התחתונה עבודה"

try {
    $root = Split-Path -Parent $PSScriptRoot
    $dataDir = Join-Path $root 'backend\data'
    $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
    $outZip = Join-Path ([Environment]::GetFolderPath('Desktop')) "bottom-line-work-data-$stamp.zip"

    if (-not (Test-Path $dataDir)) {
        Write-Host "לא נמצאה תיקיית נתונים ($dataDir) - אין מה לייצא." -ForegroundColor Red
        exit 1
    }

    if (Test-Path $outZip) { Remove-Item $outZip -Force }
    Compress-Archive -Path (Join-Path $dataDir '*') -DestinationPath $outZip -Force

    Write-Host "`nיוצא בהצלחה אל שולחן העבודה:" -ForegroundColor Green
    Write-Host $outZip -ForegroundColor White
    Write-Host "`nהעתק את הקובץ הזה למחשב השני (USB / ענן / מייל), ואז גרור אותו על Import-Data.bat שם." -ForegroundColor Gray
} catch {
    Write-Host "`nהייצוא נכשל: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Write-Host "`nלחץ מקש כלשהו כדי לסגור את החלון..." -ForegroundColor DarkGray
    $null = [System.Console]::ReadKey($true)
}

param(
    [string]$ZipPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "ייבוא נתונים - בשורה התחתונה עבודה"

try {
    $root = Split-Path -Parent $PSScriptRoot
    $dataDir = Join-Path $root 'backend\data'

    if (-not $ZipPath) {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $candidate = Get-ChildItem -Path $desktop -Filter 'bottom-line-work-data-*.zip' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $candidate) {
            Write-Host "לא צוין קובץ, ולא נמצא קובץ bottom-line-work-data-*.zip בשולחן העבודה." -ForegroundColor Red
            Write-Host "גרור את קובץ ה-ZIP שיוצא מהמחשב הראשון (Export-Data.bat) ישירות על Import-Data.bat." -ForegroundColor Gray
            exit 1
        }
        $ZipPath = $candidate.FullName
    }

    if (-not (Test-Path $ZipPath)) {
        Write-Host "הקובץ לא נמצא: $ZipPath" -ForegroundColor Red
        exit 1
    }

    Write-Host "מייבא נתונים מ:" -ForegroundColor Cyan
    Write-Host $ZipPath -ForegroundColor White

    Write-Host "`nעוצר את השרתים..." -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', 'pm2', 'stop', 'bottom-line-work-backend', 'bottom-line-work-frontend') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null

    if (Test-Path $dataDir) {
        $backupName = "data.backup-$(Get-Date -Format 'yyyy-MM-dd_HH-mm')"
        Write-Host "`nיש כבר נתונים קיימים כאן - מגבה אותם אל backend\$backupName במקום למחוק." -ForegroundColor Yellow
        Rename-Item -Path $dataDir -NewName $backupName
    }

    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $dataDir -Force

    Write-Host "`nמפעיל מחדש את השרתים..." -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', 'pm2', 'restart', 'bottom-line-work-backend', 'bottom-line-work-frontend') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null

    Write-Host "`nהייבוא הושלם בהצלחה!" -ForegroundColor Green
} catch {
    Write-Host "`nהייבוא נכשל: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Write-Host "`nלחץ מקש כלשהו כדי לסגור את החלון..." -ForegroundColor DarkGray
    $null = [System.Console]::ReadKey($true)
}

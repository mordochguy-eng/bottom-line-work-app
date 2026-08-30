$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location -Path $PSScriptRoot

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host $text -ForegroundColor Green }
function Write-Err($text)  { Write-Host $text -ForegroundColor Red }

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') נכשל (קוד $LASTEXITCODE)" }
}

$PublicRepo = 'mordochguy-eng/bottom-line-work-app'
$WorkDir    = Join-Path $env:TEMP 'bottom-line-work-publish'
$ArchiveZip = Join-Path $env:TEMP 'bottom-line-work-archive.zip'

Write-Host "==============================================" -ForegroundColor DarkCyan
Write-Host "   פרסום גרסה חדשה לריפו ההפצה" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor DarkCyan
Write-Host "`nמעדכן את הריפו הציבורי שממנו כפתור 'סנכרן גרסה' מושך." -ForegroundColor DarkGray

try {
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
    if (Test-Path $ArchiveZip) { Remove-Item $ArchiveZip -Force }

    Write-Step "מוריד את ריפו ההפצה..."
    Invoke-Git clone --quiet "https://github.com/$PublicRepo.git" $WorkDir

    Write-Step "מכין את קבצי הפרויקט (רק מה שנמצא ב-git, בלי data/ או node_modules)..."
    Invoke-Git archive --format=zip -o $ArchiveZip HEAD

    # Wipe everything except .git so deletions in the source repo propagate too.
    Get-ChildItem $WorkDir -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
    Expand-Archive -Path $ArchiveZip -DestinationPath $WorkDir -Force

    Push-Location $WorkDir
    try {
        Invoke-Git add -A
        & git diff --cached --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "`nאין שינויים לפרסום - הגרסה הציבורית כבר מעודכנת."
            return
        }

        Write-Step "מפרסם..."
        $stamp = Get-Date -Format 'dd/MM/yyyy HH:mm'
        Invoke-Git commit -q -m "Update app files ($stamp)"
        Invoke-Git push -q origin main

        Write-Ok "`nפורסם בהצלחה!"
        Write-Host "מעכשיו כפתור 'סנכרן גרסה' באפליקציה ימשוך את הגרסה הזו." -ForegroundColor Gray
    } finally {
        Pop-Location
    }
} catch {
    Write-Err "`nהפרסום נכשל: $($_.Exception.Message)"
    exit 1
} finally {
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $ArchiveZip) { Remove-Item $ArchiveZip -Force -ErrorAction SilentlyContinue }
}

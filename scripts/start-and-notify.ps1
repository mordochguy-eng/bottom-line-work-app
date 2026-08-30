# Resurrects the "בשורה התחתונה - עבודה" PM2 processes and shows a Windows
# notification with the result. Runs on boot, logon, AND wake-from-sleep
# (via Task Scheduler triggers) so the servers come back up without
# requiring a fresh user login. Same model as the personal bottom-line
# dashboard's WhatsAppDigest-AutoStart task.
#
# Status is checked over HTTP (is the server actually answering requests?)
# rather than by shelling out to `pm2` repeatedly — under Task Scheduler's
# session, spawning the pm2 CLI can hang for minutes with no error and no
# CPU usage; HTTP requests with a short timeout don't have that failure
# mode and also answer the question that actually matters.

Start-Sleep -Seconds 8

Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', 'pm2', 'resurrect') -WindowStyle Hidden | Out-Null

function Test-HttpUp {
    param([string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return $resp.StatusCode -lt 500
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { return $true }
        return $false
    } catch {
        return $false
    }
}

$backendOk = $false
$frontendOk = $false
for ($i = 0; $i -lt 12; $i++) {
    $backendOk = Test-HttpUp -Url "http://localhost:5101/api/settings"
    $frontendOk = Test-HttpUp -Url "http://localhost:5174"
    if ($backendOk -and $frontendOk) { break }
    Start-Sleep -Seconds 5
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true

if ($backendOk -and $frontendOk) {
    $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $notify.BalloonTipTitle = "בשורה התחתונה - עבודה"
    $notify.BalloonTipText = "השרתים עלו בהצלחה"
} else {
    $backendText = if ($backendOk) { "תקין" } else { "נפל" }
    $frontendText = if ($frontendOk) { "תקין" } else { "נפל" }
    $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Error
    $notify.BalloonTipTitle = "בשורה התחתונה - עבודה - תקלה"
    $notify.BalloonTipText = "Backend: $backendText | Frontend: $frontendText"
}

$notify.ShowBalloonTip(10000)
Start-Sleep -Seconds 12
$notify.Dispose()

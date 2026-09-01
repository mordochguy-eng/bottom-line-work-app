# Runs once at logon (via the Startup folder) and then stays resident,
# listening for Windows' own wake-from-sleep event — no Task Scheduler
# and no admin rights needed, which matters on a managed work laptop
# where registering a scheduled task is blocked. Every check re-runs
# `pm2 resurrect` and pops the same Windows toast as start-and-notify.ps1
# used to require a manual double-click for.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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

function Resurrect-AndNotify {
    Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', 'pm2', 'resurrect') -WindowStyle Hidden | Out-Null

    $backendOk = $false
    $frontendOk = $false
    for ($i = 0; $i -lt 12; $i++) {
        $backendOk = Test-HttpUp -Url "http://localhost:5101/api/settings"
        $frontendOk = Test-HttpUp -Url "http://localhost:5174"
        if ($backendOk -and $frontendOk) { break }
        Start-Sleep -Seconds 5
    }

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
}

# Initial check right after logon.
Start-Sleep -Seconds 8
Resurrect-AndNotify

# From here on, re-check every time Windows resumes from sleep — this is
# what makes it automatic instead of needing the desktop shortcut clicked
# by hand after every wake.
Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName "PowerModeChanged" -Action {
    if ($EventArgs.Mode -eq [Microsoft.Win32.PowerModes]::Resume) {
        Start-Sleep -Seconds 8
        Resurrect-AndNotify
    }
} | Out-Null

# Keeps this process (and its event subscription) alive indefinitely.
while ($true) { Start-Sleep -Seconds 3600 }

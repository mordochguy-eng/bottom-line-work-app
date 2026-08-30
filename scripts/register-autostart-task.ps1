$Host.UI.RawUI.WindowTitle = "רישום הפעלה אוטומטית - בשורה התחתונה עבודה"

$taskName = "BottomLineWork-AutoStart"
$notifyScript = Join-Path $PSScriptRoot "start-and-notify.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$notifyScript`""

$trigStartup = New-ScheduledTaskTrigger -AtStartup
$trigLogon = New-ScheduledTaskTrigger -AtLogOn

$cimClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace "Root/Microsoft/Windows/TaskScheduler"
$trigWake = New-CimInstance -CimClass $cimClass -ClientOnly
$trigWake.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
$trigWake.Enabled = $true

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigStartup, $trigLogon, $trigWake) -Principal $principal -Settings $settings -Force -Description "Resurrects PM2 (בשורה התחתונה - עבודה, backend+frontend) on boot, logon and wake-from-sleep, with a Windows toast on result." | Out-Null

Write-Host "`nהמשימה נרשמה בהצלחה." -ForegroundColor Green
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-List
Write-Host "מעכשיו האפליקציה תעלה אוטומטית באתחול, בכניסה, ובהתעוררות ממצב שינה." -ForegroundColor Gray
Write-Host "`nלחץ מקש כלשהו כדי לסגור את החלון..." -ForegroundColor Gray
$null = [System.Console]::ReadKey($true)

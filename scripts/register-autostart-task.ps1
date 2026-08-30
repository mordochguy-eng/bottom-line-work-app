$taskName = "BottomLineWork-AutoStart"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\AI Software\bottom-line for S-On\scripts\start-and-notify.ps1"'

$trigStartup = New-ScheduledTaskTrigger -AtStartup
$trigLogon = New-ScheduledTaskTrigger -AtLogOn

$cimClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace "Root/Microsoft/Windows/TaskScheduler"
$trigWake = New-CimInstance -CimClass $cimClass -ClientOnly
$trigWake.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
$trigWake.Enabled = $true

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigStartup, $trigLogon, $trigWake) -Principal $principal -Settings $settings -Force -Description "Resurrects PM2 (בשורה התחתונה - עבודה, backend+frontend) on boot, logon and wake-from-sleep, with a Windows toast on result." | Out-Null

Write-Host "Task registered."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-List
Start-Sleep -Seconds 5

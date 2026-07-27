import type { Playbook } from './types'

/**
 * Local-mode playbooks. Same escalation-ladder data format as the KVM ladder,
 * but the goals are command-line-first: in Local mode the model has real
 * PowerShell execution, which is faster and more reliable than screenshot
 * driving. No reboots/boot-watching by default — these are running-OS repairs.
 */

export const localNetwork: Playbook = {
  id: 'local-network',
  title: 'Network / connectivity triage',
  mode: 'local',
  tags: ['network', 'dns', 'vpn', 'connectivity', 'adapter', 'proxy'],
  steps: [
    {
      id: 'net-diagnose',
      name: 'Diagnose connectivity',
      goal:
        'Establish where connectivity breaks. Check adapter state, IP config, ' +
        'default gateway reachability, DNS resolution, and whether a proxy is set. ' +
        'Report a clear picture before changing anything.',
      hints: [
        'Get-NetAdapter | Where-Object Status -ne "Disabled"',
        'Get-NetIPConfiguration',
        'Test-NetConnection 8.8.8.8 -InformationLevel Detailed',
        'Resolve-DnsName microsoft.com',
        'netsh winhttp show proxy'
      ]
    },
    {
      id: 'net-dns-flush',
      name: 'Flush DNS and reset resolver',
      goal: 'Clear the DNS cache and re-register, then re-test name resolution.',
      hints: ['Clear-DnsClientCache', 'ipconfig /flushdns', 'ipconfig /registerdns']
    },
    {
      id: 'net-adapter-reset',
      name: 'Reset the adapter / IP stack',
      goal:
        'Release and renew DHCP, then reset the adapter if needed. As a last ' +
        'resort reset Winsock and the TCP/IP stack (this needs a reboot to fully ' +
        'apply — tell the admin).',
      hints: [
        'ipconfig /release; ipconfig /renew',
        'Restart-NetAdapter -Name "<adapter>"',
        'netsh winsock reset',
        'netsh int ip reset'
      ]
    },
    {
      id: 'net-proxy-check',
      name: 'Check and clear a bad proxy',
      goal:
        'A stale or wrong proxy commonly breaks connectivity for some apps. ' +
        'Inspect WinHTTP and WinINET proxy settings; if clearly wrong, clear them.',
      hints: [
        'netsh winhttp show proxy',
        'Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" | Select ProxyEnable,ProxyServer',
        'netsh winhttp reset proxy'
      ]
    }
  ]
}

export const localWindowsUpdate: Playbook = {
  id: 'local-windows-update',
  title: 'Stuck Windows Update',
  mode: 'local',
  tags: ['windows-update', 'wuauserv', 'update', 'stuck', 'softwaredistribution'],
  steps: [
    {
      id: 'wu-status',
      name: 'Check update service status',
      goal:
        'Report the state of the Windows Update stack: service status, last error, ' +
        'and whether an update is mid-install or wedged.',
      hints: [
        'Get-Service wuauserv,bits,cryptsvc,msiserver | Select Name,Status',
        'Get-WindowsUpdateLog is slow; prefer: Get-WinEvent -LogName "System" -MaxEvents 50 | Where-Object Id -in 19,20,43'
      ]
    },
    {
      id: 'wu-reset',
      name: 'Reset the update components',
      goal:
        'Stop the update services, rename SoftwareDistribution and catroot2 so ' +
        'they rebuild, then restart the services and retry a scan. Renaming (not ' +
        'deleting) is the safe reset.',
      hints: [
        'Stop-Service wuauserv,bits,cryptsvc,msiserver -Force',
        'Rename-Item $env:windir\\SoftwareDistribution SoftwareDistribution.old',
        'Rename-Item $env:windir\\System32\\catroot2 catroot2.old',
        'Start-Service wuauserv,bits,cryptsvc,msiserver',
        'Get-WindowsUpdate or usoclient StartScan'
      ]
    },
    {
      id: 'wu-repair-image',
      name: 'Repair the component store',
      goal:
        'If updates still fail, repair the servicing/component store with DISM and ' +
        'SFC so the next update can apply.',
      hints: [
        'DISM /Online /Cleanup-Image /RestoreHealth',
        'sfc /scannow'
      ]
    }
  ]
}

export const localPrinter: Playbook = {
  id: 'local-printer',
  title: 'Printer queue reset',
  mode: 'local',
  tags: ['printer', 'spooler', 'print-queue', 'printing'],
  steps: [
    {
      id: 'printer-status',
      name: 'Inspect the spooler and queue',
      goal: 'Report spooler service state and any stuck jobs across printers.',
      hints: [
        'Get-Service spooler | Select Status',
        'Get-Printer | Select Name,PrinterStatus',
        'Get-PrintJob -PrinterName * | Select PrinterName,Id,JobStatus'
      ]
    },
    {
      id: 'printer-clear-queue',
      name: 'Clear the stuck queue',
      goal:
        'Stop the spooler, delete the queued job files, then restart the spooler ' +
        'so printing resumes. Deleting spool files under the spool folder is the ' +
        'standard, safe reset.',
      hints: [
        'Stop-Service spooler -Force',
        'Remove-Item "$env:windir\\System32\\spool\\PRINTERS\\*" -Force',
        'Start-Service spooler'
      ]
    }
  ]
}

export const localDiskSpace: Playbook = {
  id: 'local-disk-space',
  title: 'Disk-space cleanup',
  mode: 'local',
  tags: ['disk', 'disk-space', 'storage', 'cleanup', 'full-disk'],
  steps: [
    {
      id: 'disk-report',
      name: 'Report space and top consumers',
      goal:
        'Report free space per volume and the largest space consumers so cleanup ' +
        'is targeted, not blind.',
      hints: [
        'Get-Volume | Select DriveLetter,FileSystemLabel,SizeRemaining,Size',
        'Get-ChildItem C:\\ -Directory | ForEach-Object { [PSCustomObject]@{Path=$_.FullName; GB=[math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1GB,2)} } | Sort-Object GB -Descending'
      ]
    },
    {
      id: 'disk-temp-cleanup',
      name: 'Clean safe temp locations',
      goal:
        'Free space by clearing temp folders, the Recycle Bin, and Windows Update ' +
        'download cache — safe locations only. Do not touch user documents.',
      hints: [
        'Remove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue',
        'Remove-Item "$env:windir\\Temp\\*" -Recurse -Force -ErrorAction SilentlyContinue',
        'Clear-RecycleBin -Force -ErrorAction SilentlyContinue',
        'cleanmgr /verylowdisk (interactive) or dism /online /cleanup-image /startcomponentcleanup'
      ]
    }
  ]
}

export const localSlowMachine: Playbook = {
  id: 'local-slow-machine',
  title: 'Slow-machine triage',
  mode: 'local',
  tags: ['slow', 'performance', 'startup', 'resource-hog', 'cpu', 'memory'],
  steps: [
    {
      id: 'slow-resource-hogs',
      name: 'Find resource hogs',
      goal:
        'Identify what is consuming CPU, memory, and disk right now so the cause ' +
        'is known before changing anything.',
      hints: [
        'Get-Process | Sort-Object CPU -Descending | Select -First 10 Name,CPU,WorkingSet',
        'Get-Counter "\\Processor(_Total)\\% Processor Time","\\Memory\\Available MBytes"',
        'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Sort IODataBytesPersec -Descending | Select -First 5 Name,IODataBytesPersec'
      ]
    },
    {
      id: 'slow-startup-items',
      name: 'Review startup items',
      goal:
        'Review programs that run at startup and recommend (with approval) ' +
        'disabling unnecessary ones that slow boot and login.',
      hints: [
        'Get-CimInstance Win32_StartupCommand | Select Name,Command,Location',
        'Get-ScheduledTask | Where-Object {$_.Triggers.Enabled -and $_.State -eq "Ready"} | Select TaskName,TaskPath'
      ]
    },
    {
      id: 'slow-health-check',
      name: 'Quick health check',
      goal:
        'Check for the common quiet causes of slowness: pending reboot, low disk, ' +
        'failing disk SMART status, and thermal/throttling signs.',
      hints: [
        'Get-PhysicalDisk | Select FriendlyName,HealthStatus,OperationalStatus',
        'Get-Volume | Select DriveLetter,SizeRemaining,Size',
        'Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired"'
      ]
    }
  ]
}

export const localPlaybooks: Playbook[] = [
  localNetwork,
  localWindowsUpdate,
  localPrinter,
  localDiskSpace,
  localSlowMachine
]

import { desktopCapturer, screen } from 'electron'
import { createLogger } from '../logger'
import { runPowerShell, isElevated } from './powershell'
import type { CommandResult, TargetMode } from '@shared/types'
import type {
  PerceiveResult,
  RenderedAction,
  TargetBackend,
  ToolExecResult,
  ToolInvocation
} from './types'

const logger = createLogger('local-backend')

/**
 * Local backend — the app repairs the computer it runs on. Perception and
 * action are command execution (strictly better than screenshots for the local
 * desktop): a `run_powershell` tool plus diagnostic helpers, and an optional
 * screenshot for genuinely UI-visible issues.
 */
export class LocalBackend implements TargetBackend {
  readonly mode: TargetMode = 'local'
  readonly supportsReboot = false
  private elevated = false

  async connect(): Promise<void> {
    this.elevated = await isElevated()
  }

  async dispose(): Promise<void> {
    /* nothing to tear down */
  }

  tools(): Record<string, unknown>[] {
    return [
      {
        name: 'run_powershell',
        description:
          'Run a PowerShell command on this Windows machine and get stdout, ' +
          'stderr, and the exit code back as text. Prefer this over screenshots — ' +
          'it is faster and more reliable. Keep commands read-only until you have ' +
          'diagnosed the problem.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The PowerShell command to run.' }
          },
          required: ['command']
        }
      },
      {
        name: 'query_event_log',
        description: 'Query a Windows event log (wraps Get-WinEvent).',
        input_schema: {
          type: 'object',
          properties: {
            log_name: { type: 'string', description: 'e.g. System, Application, Setup.' },
            max_events: { type: 'integer', description: 'Default 40.' },
            id_filter: { type: 'string', description: 'Optional comma-separated event IDs.' }
          },
          required: ['log_name']
        }
      },
      {
        name: 'service_status',
        description: 'Get the status of Windows services (wraps Get-Service).',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional service name or wildcard.' }
          }
        }
      },
      {
        name: 'disk_report',
        description: 'Report free space per volume and physical-disk health.',
        input_schema: { type: 'object', properties: {} }
      },
      {
        name: 'network_diag',
        description: 'Summarize adapters, IP config, DNS resolution, and proxy settings.',
        input_schema: { type: 'object', properties: {} }
      },
      {
        name: 'local_screenshot',
        description:
          'Capture a screenshot of this machine, for UI-visible issues that ' +
          'command output cannot show. Use sparingly.',
        input_schema: { type: 'object', properties: {} }
      }
    ]
  }

  betas(): string[] {
    return []
  }

  systemHint(): string {
    return (
      `You are repairing THIS Windows machine directly. You have real command ` +
      `execution via run_powershell — use it as your primary channel; it is ` +
      `faster and more reliable than screenshots. ${this.elevated ? 'The app is ' +
      'running as Administrator.' : 'The app is NOT elevated — some fixes will ' +
      'need admin rights; say so and the admin can relaunch elevated.'} Diagnose ` +
      `with read-only commands before changing anything, and explain each command.`
    )
  }

  async perceive(): Promise<PerceiveResult> {
    const res = await runPowerShell(
      '$os=Get-CimInstance Win32_OperatingSystem; ' +
        '"Host: $($env:COMPUTERNAME)`nOS: $($os.Caption) $($os.Version)`n' +
        'Uptime since: $($os.LastBootUpTime)"',
      { timeoutMs: 15_000 }
    )
    const elev = this.elevated ? 'Administrator' : 'standard user'
    const text =
      `This machine (running as ${elev}):\n` +
      (res.stdout.trim() || res.stderr.trim() || '(system info unavailable)')
    return { text }
  }

  async watchFrame(): Promise<PerceiveResult> {
    // Local mode does not reboot/boot-watch; return a lightweight text frame.
    return { text: 'Local machine (no boot watch).' }
  }

  renderAction(inv: ToolInvocation): RenderedAction {
    switch (inv.name) {
      case 'run_powershell': {
        const cmd = String(inv.input.command ?? '')
        return { kind: 'local_powershell', summary: `Run: ${truncate(cmd, 60)}`, detail: cmd }
      }
      case 'query_event_log':
        return { kind: 'local_powershell', summary: `Query ${String(inv.input.log_name)} event log`, detail: this.buildEventLogCmd(inv.input) }
      case 'service_status':
        return { kind: 'local_powershell', summary: 'Check service status', detail: this.buildServiceCmd(inv.input) }
      case 'disk_report':
        return { kind: 'local_powershell', summary: 'Disk / volume report', detail: DISK_CMD }
      case 'network_diag':
        return { kind: 'local_powershell', summary: 'Network diagnostics', detail: NET_CMD }
      case 'local_screenshot':
        return { kind: 'local_screenshot', summary: 'Take a local screenshot', detail: 'desktopCapturer' }
      default:
        return { kind: 'note', summary: inv.name, detail: JSON.stringify(inv.input) }
    }
  }

  async execute(inv: ToolInvocation): Promise<ToolExecResult> {
    switch (inv.name) {
      case 'run_powershell':
        return this.runAndFormat(String(inv.input.command ?? ''))
      case 'query_event_log':
        return this.runAndFormat(this.buildEventLogCmd(inv.input))
      case 'service_status':
        return this.runAndFormat(this.buildServiceCmd(inv.input))
      case 'disk_report':
        return this.runAndFormat(DISK_CMD)
      case 'network_diag':
        return this.runAndFormat(NET_CMD)
      case 'local_screenshot':
        return this.screenshot()
      default:
        return { resultText: `Unknown tool: ${inv.name}`, isError: true, actionLog: [] }
    }
  }

  reboot(): Promise<void> {
    // Not supported for the machine we run on (v1). No-op.
    return Promise.resolve()
  }

  // --- helpers -------------------------------------------------------------

  private async runAndFormat(command: string): Promise<ToolExecResult> {
    if (!command.trim()) {
      return { resultText: 'Empty command.', isError: true, actionLog: [] }
    }
    const res = await runPowerShell(command)
    const isError = res.exitCode !== 0 && res.exitCode !== null
    const accessDenied = /access is denied|requires elevation|unauthorizedaccess/i.test(
      res.stderr + res.stdout
    )
    const elevHint =
      accessDenied && !this.elevated
        ? '\n\nNote: this looks like it needs Administrator rights, and the app is ' +
          'not elevated. Recommend the admin relaunch as Administrator.'
        : ''
    return {
      resultText: formatCommandResult(res) + elevHint,
      isError,
      actionLog: [`$ ${truncate(command, 120)} (exit ${res.exitCode})`]
    }
  }

  private async screenshot(): Promise<ToolExecResult> {
    try {
      const primary = screen.getPrimaryDisplay()
      const scale = Math.min(1, 1280 / primary.size.width, 800 / primary.size.height)
      const width = Math.max(1, Math.round(primary.size.width * scale))
      const height = Math.max(1, Math.round(primary.size.height * scale))
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })
      const src = sources[0]
      if (!src || src.thumbnail.isEmpty()) {
        return { resultText: 'No screen source available.', isError: true, actionLog: [] }
      }
      const jpeg = src.thumbnail.toJPEG(70).toString('base64')
      return {
        resultText: 'Local screenshot captured.',
        imageBase64: jpeg,
        imageMediaType: 'image/jpeg',
        actionLog: ['local screenshot']
      }
    } catch (err) {
      logger.error('Local screenshot failed', err)
      return { resultText: `Screenshot failed: ${(err as Error).message}`, isError: true, actionLog: [] }
    }
  }

  private buildEventLogCmd(input: Record<string, unknown>): string {
    const logName = String(input.log_name ?? 'System').replace(/["`;]/g, '')
    const max = Number(input.max_events ?? 40)
    const ids = typeof input.id_filter === 'string' && input.id_filter.trim()
      ? `.Where({ $_.Id -in @(${input.id_filter.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)).join(',')}) })`
      : ''
    return (
      `Get-WinEvent -LogName '${logName}' -MaxEvents ${Number.isFinite(max) ? max : 40} ` +
      `-ErrorAction SilentlyContinue ${ids} | ` +
      `Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message | Format-List`
    )
  }

  private buildServiceCmd(input: Record<string, unknown>): string {
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.replace(/["`;]/g, '') : ''
    return name
      ? `Get-Service -Name '${name}' -ErrorAction SilentlyContinue | Select-Object Name,DisplayName,Status,StartType | Format-Table -AutoSize`
      : `Get-Service | Where-Object { $_.Status -ne 'Running' } | Select-Object Name,DisplayName,Status,StartType | Format-Table -AutoSize`
  }
}

const DISK_CMD =
  'Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter,FileSystemLabel,' +
  '@{n="FreeGB";e={[math]::Round($_.SizeRemaining/1GB,1)}},@{n="SizeGB";e={[math]::Round($_.Size/1GB,1)}} | Format-Table -AutoSize; ' +
  'Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus,OperationalStatus | Format-Table -AutoSize'

const NET_CMD =
  'Get-NetAdapter | Where-Object Status -ne "Disabled" | Select-Object Name,Status,LinkSpeed | Format-Table -AutoSize; ' +
  'Get-NetIPConfiguration | Select-Object InterfaceAlias,IPv4Address,IPv4DefaultGateway | Format-List; ' +
  '"Proxy:"; netsh winhttp show proxy; ' +
  '"DNS test:"; try { (Resolve-DnsName microsoft.com -ErrorAction Stop | Select-Object -First 1).IPAddress } catch { "DNS resolution failed: $_" }'

function formatCommandResult(res: CommandResult): string {
  const out = res.stdout.trim() || '(no stdout)'
  const err = res.stderr.trim()
  return (
    `exit code: ${res.exitCode ?? 'n/a'}  (${res.durationMs}ms${res.truncated ? ', output truncated' : ''})\n` +
    `--- stdout ---\n${out}` +
    (err ? `\n--- stderr ---\n${err}` : '')
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

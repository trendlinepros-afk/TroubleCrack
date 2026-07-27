import { spawn } from 'node:child_process'
import { createLogger } from '../logger'
import type { CommandResult } from '@shared/types'

const logger = createLogger('powershell')

const MAX_OUTPUT_CHARS = 60_000

export interface RunOptions {
  timeoutMs?: number
  cwd?: string
}

/**
 * Run a PowerShell command on the local machine, capturing stdout/stderr/exit.
 * Returns a structured result rather than throwing, so the orchestrator can
 * feed failures back to the model. On non-Windows hosts it returns a clear
 * error result instead of crashing (Local mode targets Windows).
 */
export function runPowerShell(command: string, opts: RunOptions = {}): Promise<CommandResult> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 120_000

  if (process.platform !== 'win32') {
    return Promise.resolve({
      command,
      stdout: '',
      stderr:
        'Local mode requires Windows PowerShell. This host is not Windows, so ' +
        'the command was not run.',
      exitCode: null,
      durationMs: Date.now() - started,
      elevated: false,
      truncated: false
    })
  }

  return new Promise<CommandResult>((resolve) => {
    // -NoProfile keeps startup fast and deterministic; -NonInteractive prevents
    // any prompt from hanging the child. The command is passed via -Command.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { cwd: opts.cwd, windowsHide: true }
    )

    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false

    const cap = (chunk: string, isErr: boolean): void => {
      if (isErr) {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk
        else truncated = true
      } else {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk
        else truncated = true
      }
    }

    child.stdout.on('data', (d: Buffer) => cap(d.toString('utf8'), false))
    child.stderr.on('data', (d: Buffer) => cap(d.toString('utf8'), true))

    const timer = setTimeout(() => {
      if (settled) return
      logger.warn(`PowerShell command timed out after ${timeoutMs}ms; killing`)
      child.kill('SIGKILL')
      settle(null, `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`)
    }, timeoutMs)

    const settle = (code: number | null, extraErr?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        command,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: (extraErr ? extraErr + '\n' : '') + stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: code,
        durationMs: Date.now() - started,
        elevated: cachedElevation ?? false,
        truncated
      })
    }

    child.on('error', (err) => settle(null, `Failed to start PowerShell: ${err.message}`))
    child.on('close', (code) => settle(code))
  })
}

let cachedElevation: boolean | null = null

/** Detect whether the app process is running elevated (admin). Cached. */
export async function isElevated(): Promise<boolean> {
  if (cachedElevation !== null) return cachedElevation
  if (process.platform !== 'win32') {
    cachedElevation = false
    return false
  }
  const res = await runPowerShell(
    '$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); ' +
      'if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { "ELEVATED" } else { "STANDARD" }',
    { timeoutMs: 10_000 }
  )
  cachedElevation = /ELEVATED/.test(res.stdout)
  return cachedElevation
}

export function resetElevationCache(): void {
  cachedElevation = null
}

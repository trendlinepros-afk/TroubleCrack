import { spawn } from 'node:child_process'
import { app } from 'electron'
import { createLogger } from './logger'
import { isElevated } from './backends/powershell'
import type { ElevationStatus } from '@shared/types'
import type { RelaunchResult } from '@shared/ipc-contract'

const logger = createLogger('system')

export async function getElevationStatus(): Promise<ElevationStatus> {
  const supported = process.platform === 'win32'
  const elevated = supported ? await isElevated() : false
  return { supported, elevated, platform: process.platform }
}

/**
 * Relaunch the app elevated. Never attempts silent elevation — this is only
 * ever called from an explicit "Relaunch as Administrator" click. Uses the
 * Windows UAC prompt via Start-Process -Verb RunAs.
 */
export async function relaunchAsAdmin(): Promise<RelaunchResult> {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Elevation is only supported on Windows.' }
  }
  if (await isElevated()) {
    return { ok: false, message: 'The app is already running as Administrator.' }
  }
  try {
    const exe = process.execPath
    // Detach a PowerShell that re-launches this exe with the UAC prompt.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    logger.info('Requested elevated relaunch; quitting current instance')
    // Give the UAC prompt a beat to appear before we quit.
    setTimeout(() => app.quit(), 800)
    return { ok: true, message: 'Relaunching as Administrator (approve the Windows prompt).' }
  } catch (err) {
    logger.error('Elevated relaunch failed', err)
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

import pkg from 'electron-updater'
import { app } from 'electron'
import { createLogger } from './logger'
import { loadSettings } from './settings'
import { sessionManager } from './orchestrator/manager'
import type { UpdateStatus } from '@shared/types'
import type { UpdateCheckResult } from '@shared/ipc-contract'

const { autoUpdater } = pkg
const logger = createLogger('updater')

let broadcast: ((s: UpdateStatus) => void) | null = null
let status: UpdateStatus = { state: 'idle' }
let downloadedVersion: string | null = null
let dailyTimer: ReturnType<typeof setInterval> | null = null

function set(s: UpdateStatus): void {
  status = s
  broadcast?.(s)
}

export function setUpdateBroadcaster(fn: ((s: UpdateStatus) => void) | null): void {
  broadcast = fn
}

export function currentUpdateStatus(): UpdateStatus {
  return status
}

export function initUpdater(): void {
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  // We control the install moment; never restart mid-session.
  autoUpdater.autoInstallOnAppQuit = true

  // Point at the configured GitHub repo if one is set; otherwise rely on the
  // packaged publish config (absent in dev, which just yields a clean "no updates").
  const repo = loadSettings().updateRepo
  if (repo && repo.includes('/')) {
    const [owner, name] = repo.split('/')
    try {
      autoUpdater.setFeedURL({ provider: 'github', owner: owner!, repo: name! })
    } catch (err) {
      logger.warn('Could not set update feed URL from settings')
    }
  }

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => set({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    if (sessionManager.isBusy()) {
      // Defer: never interrupt a live repair. We re-surface when it ends.
      logger.info(`Update ${info.version} downloaded; deferred (session active)`)
      set({ state: 'deferred', version: info.version, message: 'Update ready; will prompt after the session ends.' })
    } else {
      set({ state: 'downloaded', version: info.version })
    }
  })
  autoUpdater.on('error', (err) => {
    logger.warn(`Update error: ${err.message}`)
    set({ state: 'error', message: err.message })
  })

  // Silent daily check.
  dailyTimer = setInterval(() => {
    void checkForUpdates(true)
  }, 24 * 60 * 60 * 1000)

  // If an update was deferred during a session, surface it once the session ends.
  setInterval(() => {
    if (status.state === 'deferred' && !sessionManager.isBusy() && downloadedVersion) {
      set({ state: 'downloaded', version: downloadedVersion })
    }
  }, 15_000)
}

export async function checkForUpdates(silent = false): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return { state: 'none', message: 'Updates are only checked in packaged builds.' }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (version && version !== app.getVersion()) {
      return { state: 'available', version }
    }
    return { state: 'none' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!silent) logger.warn(`Update check failed: ${message}`)
    return { state: 'error', message }
  }
}

export function quitAndInstall(): void {
  if (sessionManager.isBusy()) {
    logger.warn('Refused quitAndInstall while a session is active')
    return
  }
  logger.info('Quitting to install update')
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

export function disposeUpdater(): void {
  if (dailyTimer) clearInterval(dailyTimer)
}

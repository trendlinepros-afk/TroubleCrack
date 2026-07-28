import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { buildSessionSummary, summaryFileName } from '@shared/summary'
import type { SummaryExportResult } from '@shared/ipc-contract'
import type { SessionSnapshot } from '@shared/types'
import { loadSettings, summaryExportDir } from './settings'
import { createLogger } from './logger'

const logger = createLogger('session-export')

/**
 * Export a Markdown summary of a session to a file the operator picks. Works
 * mid-session (progress so far) and after it ends. The snapshot is passed in by
 * the caller so this module stays free of the session manager (no import cycle).
 */
export async function exportSummaryToFile(
  win: BrowserWindow | null,
  snapshot: SessionSnapshot | null,
  fromMenu = false
): Promise<SummaryExportResult> {
  if (!snapshot) return noSession(win, fromMenu)
  try {
    const markdown = buildSessionSummary(snapshot, { appVersion: app.getVersion() })
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Export repair summary',
      defaultPath: summaryFileName(snapshot),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await fs.writeFile(result.filePath, markdown, 'utf8')
    logger.info(`Exported session summary to ${result.filePath}`)
    return { ok: true, path: result.filePath }
  } catch (err) {
    logger.error('Failed to export session summary', err)
    return { ok: false, error: err instanceof Error ? err.message : 'Export failed' }
  }
}

/** Copy the same Markdown summary to the system clipboard. */
export function copySummaryToClipboard(
  win: BrowserWindow | null,
  snapshot: SessionSnapshot | null,
  fromMenu = false
): SummaryExportResult {
  if (!snapshot) return noSession(win, fromMenu)
  try {
    clipboard.writeText(buildSessionSummary(snapshot, { appVersion: app.getVersion() }))
    logger.info('Copied session summary to clipboard')
    return { ok: true }
  } catch (err) {
    logger.error('Failed to copy session summary', err)
    return { ok: false, error: err instanceof Error ? err.message : 'Copy failed' }
  }
}

/**
 * Automatically write a summary when a session ends, to the configured (or
 * default) folder. Defensive: never throws — a failed export must never disturb
 * session teardown. Returns the written path, or null if disabled/skipped/failed.
 */
export async function autoExportSummary(snapshot: SessionSnapshot): Promise<string | null> {
  const settings = loadSettings()
  if (!settings.autoExportSummary) return null
  // Don't clutter the folder with empty records from a session aborted before it
  // did anything; a natural end always writes, even with zero attempts.
  if (snapshot.attempts.length === 0 && snapshot.runState === 'stopped') return null

  try {
    const dir = summaryExportDir()
    await fs.mkdir(dir, { recursive: true })
    const markdown = buildSessionSummary(snapshot, { appVersion: app.getVersion() })
    const target = await uniquePath(dir, summaryFileName(snapshot))
    await fs.writeFile(target, markdown, 'utf8')
    logger.info(`Auto-saved session summary to ${target}`)
    return target
  } catch (err) {
    logger.error('Auto-export of session summary failed (continuing without it)', err)
    return null
  }
}

/** Return `<dir>/<name>`, appending -1, -2, … if that file already exists. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  let n = 1
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`)
    n += 1
  }
  return candidate
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** When triggered from the menu with no session, explain rather than no-op. */
function noSession(win: BrowserWindow | null, fromMenu: boolean): SummaryExportResult {
  if (fromMenu && win && !win.isDestroyed()) {
    void dialog.showMessageBox(win, {
      type: 'info',
      title: 'Nothing to export yet',
      message: 'No repair session to summarize',
      detail: 'Start a session (or reopen a past one) and you can export a summary of the steps taken.',
      buttons: ['OK']
    })
  }
  return { ok: false, error: 'There is no session to export yet.' }
}

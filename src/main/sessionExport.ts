import { promises as fs } from 'node:fs'
import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { buildSessionSummary, summaryFileName } from '@shared/summary'
import type { SummaryExportResult } from '@shared/ipc-contract'
import { sessionManager } from './orchestrator/manager'
import { createLogger } from './logger'

const logger = createLogger('session-export')

/**
 * Export a Markdown summary of the current (or last) session to a file the
 * operator picks. Works mid-session (progress so far) and after it ends.
 */
export async function exportSummaryToFile(
  win: BrowserWindow | null,
  fromMenu = false
): Promise<SummaryExportResult> {
  const snapshot = sessionManager.getSnapshot()
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
export function copySummaryToClipboard(win: BrowserWindow | null, fromMenu = false): SummaryExportResult {
  const snapshot = sessionManager.getSnapshot()
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

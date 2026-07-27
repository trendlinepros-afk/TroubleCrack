import log from 'electron-log/main'
import type { LogEvent } from '@shared/types'

/**
 * Central logging. electron-log writes a rotating file; we also mirror every
 * record to the renderer so the UI can show plain-English events. No raw stack
 * traces reach the UI — errors are logged in full to file, summarized to the UI.
 */

let broadcaster: ((e: LogEvent) => void) | null = null

export function initLogger(): void {
  log.transports.file.level = 'info'
  log.transports.console.level = 'debug'
  // Rotate at 5 MB; electron-log keeps the previous file as <name>.old.log.
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  log.errorHandler.startCatching({ showDialog: false })
  log.eventLogger.startLogging()
}

/** Wire the renderer broadcast once the main window exists. */
export function setLogBroadcaster(fn: ((e: LogEvent) => void) | null): void {
  broadcaster = fn
}

function emit(level: LogEvent['level'], scope: string, message: string): void {
  const line = `[${scope}] ${message}`
  log[level](line)
  broadcaster?.({ ts: Date.now(), level, scope, message })
}

export function createLogger(scope: string) {
  return {
    debug: (m: string) => emit('debug', scope, m),
    info: (m: string) => emit('info', scope, m),
    warn: (m: string) => emit('warn', scope, m),
    error: (m: string, err?: unknown) => {
      // Full error (with stack) to file; concise message to the UI.
      if (err !== undefined) log.error(`[${scope}]`, m, err)
      const detail = err instanceof Error ? `: ${err.message}` : ''
      emit('error', scope, `${m}${detail}`)
    }
  }
}

export type ScopedLogger = ReturnType<typeof createLogger>
export { log as rawLog }

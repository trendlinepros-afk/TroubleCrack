/** Minimal electron-log/main stub for tests (the real one requires Electron). */
const noop = (): void => {}
const log = {
  transports: {
    file: { level: 'info', maxSize: 0, format: '' },
    console: { level: 'debug' }
  },
  errorHandler: { startCatching: noop },
  eventLogger: { startLogging: noop },
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
}
export default log

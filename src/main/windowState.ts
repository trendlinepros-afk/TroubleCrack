import { screen, type BrowserWindow } from 'electron'
import { JsonStore } from './store'
import { createLogger } from './logger'

const logger = createLogger('window-state')

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const MIN_WIDTH = 1024
const MIN_HEIGHT = 680
const DEFAULT: WindowBounds = { width: 1440, height: 900 }

const store = new JsonStore<WindowBounds>('window.json', DEFAULT)

/** Load the last window bounds, clamped to sane sizes. Position is dropped if it
 *  no longer lands on a connected display (so the window can't open off-screen). */
export function loadWindowBounds(): WindowBounds {
  const b = store.read()
  const width = clamp(b.width ?? DEFAULT.width, MIN_WIDTH, 20000)
  const height = clamp(b.height ?? DEFAULT.height, MIN_HEIGHT, 20000)
  const base: WindowBounds = { width, height, maximized: b.maximized === true }
  if (typeof b.x === 'number' && typeof b.y === 'number' && onSomeDisplay(b.x, b.y, width, height)) {
    base.x = b.x
    base.y = b.y
  }
  return base
}

/** Persist bounds (debounced) whenever the user moves, resizes, or (un)maximizes. */
export function trackWindow(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed()) return
      try {
        const maximized = win.isMaximized()
        // getNormalBounds is the restored (un-maximized) rectangle — what we want
        // to re-open at while still remembering the maximized flag.
        const b = win.getNormalBounds()
        void store.write({ x: b.x, y: b.y, width: b.width, height: b.height, maximized })
      } catch (err) {
        logger.warn('Could not persist window bounds')
      }
    }, 400)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/** True if the given rectangle intersects the work area of any connected display. */
function onSomeDisplay(x: number, y: number, w: number, h: number): boolean {
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return x < a.x + a.width && x + w > a.x && y < a.y + a.height && y + h > a.y
    })
  } catch {
    return true
  }
}

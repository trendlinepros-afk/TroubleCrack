import { HID_MODIFIER, KVM_ABS_MAX, KVM_MOUSE_BUTTON } from '@shared/constants'
import type { KvmActionPayload } from '@shared/ipc-contract'

type Exec = (p: KvmActionPayload) => void

interface Handlers {
  mousemove: (e: MouseEvent) => void
  mousedown: (e: MouseEvent) => void
  mouseup: (e: MouseEvent) => void
  wheel: (e: WheelEvent) => void
  contextmenu: (e: MouseEvent) => void
  keydown: (e: KeyboardEvent) => void
  keyup: (e: KeyboardEvent) => void
  buttons: number
}

const attached = new WeakMap<HTMLVideoElement, Handlers>()

/** KeyboardEvent.code → HID usage code, for manual pass-through. */
const CODE_TO_USAGE: Record<string, number> = {
  Enter: 0x28,
  NumpadEnter: 0x58,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  PrintScreen: 0x46
}

function usageForCode(code: string): number | null {
  if (CODE_TO_USAGE[code] !== undefined) return CODE_TO_USAGE[code]
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65)
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (Number(code.slice(5)) - 1)
  if (code === 'Digit0') return 0x27
  if (/^F([1-9]|1[0-2])$/.test(code)) return 0x3a + (Number(code.slice(1)) - 1)
  if (/^Numpad[0-9]$/.test(code)) {
    const n = Number(code.slice(6))
    return n === 0 ? 0x62 : 0x59 + (n - 1)
  }
  return null
}

function modifierFor(e: KeyboardEvent): number {
  let m = 0
  if (e.ctrlKey) m |= HID_MODIFIER.LeftCtrl
  if (e.shiftKey) m |= HID_MODIFIER.LeftShift
  if (e.altKey) m |= HID_MODIFIER.LeftAlt
  if (e.metaKey) m |= HID_MODIFIER.LeftGui
  return m
}

function absCoords(el: HTMLVideoElement, e: MouseEvent): { x: number; y: number } {
  const rect = el.getBoundingClientRect()
  const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
  return { x: Math.round(fx * KVM_ABS_MAX), y: Math.round(fy * KVM_ABS_MAX) }
}

function buttonBit(button: number): number {
  if (button === 2) return KVM_MOUSE_BUTTON.Right
  if (button === 1) return KVM_MOUSE_BUTTON.Middle
  return KVM_MOUSE_BUTTON.Left
}

/**
 * When "Manual control" is on, the admin's clicks/keystrokes in the preview pass
 * straight through to the target. Modifier keys are held for as long as they are
 * physically held (unlike the agent's fire-and-forget key presses).
 */
export function attachManualControl(el: HTMLVideoElement, exec: Exec): void {
  if (attached.has(el)) return
  el.tabIndex = 0

  const state: Handlers = {
    buttons: 0,
    mousemove: (e) => {
      const { x, y } = absCoords(el, e)
      exec({ kind: 'rpc', method: 'absMouseReport', params: { x, y, buttons: state.buttons } })
    },
    mousedown: (e) => {
      e.preventDefault()
      el.focus()
      state.buttons |= buttonBit(e.button)
      const { x, y } = absCoords(el, e)
      exec({ kind: 'rpc', method: 'absMouseReport', params: { x, y, buttons: state.buttons } })
    },
    mouseup: (e) => {
      e.preventDefault()
      state.buttons &= ~buttonBit(e.button)
      const { x, y } = absCoords(el, e)
      exec({ kind: 'rpc', method: 'absMouseReport', params: { x, y, buttons: state.buttons } })
    },
    wheel: (e) => {
      e.preventDefault()
      exec({ kind: 'rpc', method: 'wheelReport', params: { wheelY: e.deltaY > 0 ? -1 : 1, wheelX: 0 } })
    },
    contextmenu: (e) => e.preventDefault(),
    keydown: (e) => {
      const usage = usageForCode(e.code)
      e.preventDefault()
      exec({
        kind: 'rpc',
        method: 'keyboardReport',
        params: { modifier: modifierFor(e), keys: usage !== null ? [usage] : [] }
      })
    },
    keyup: (e) => {
      e.preventDefault()
      exec({ kind: 'rpc', method: 'keyboardReport', params: { modifier: 0, keys: [] } })
    }
  }

  el.addEventListener('mousemove', state.mousemove)
  el.addEventListener('mousedown', state.mousedown)
  el.addEventListener('mouseup', state.mouseup)
  el.addEventListener('wheel', state.wheel, { passive: false })
  el.addEventListener('contextmenu', state.contextmenu)
  el.addEventListener('keydown', state.keydown)
  el.addEventListener('keyup', state.keyup)
  attached.set(el, state)
}

export function detachManualControl(el: HTMLVideoElement): void {
  const state = attached.get(el)
  if (!state) return
  el.removeEventListener('mousemove', state.mousemove)
  el.removeEventListener('mousedown', state.mousedown)
  el.removeEventListener('mouseup', state.mouseup)
  el.removeEventListener('wheel', state.wheel)
  el.removeEventListener('contextmenu', state.contextmenu)
  el.removeEventListener('keydown', state.keydown)
  el.removeEventListener('keyup', state.keyup)
  attached.delete(el)
}

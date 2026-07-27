/**
 * USB HID keyboard mapping. Converts the model's key-combo / type actions (which
 * use X11 / xdotool-style names, e.g. "ctrl+alt+Delete", "shift+F10", "Return")
 * and plain text into HID keyboard reports the JetKVM understands
 * (`keyboardReport{modifier, keys}`). Shared so the KVM backend and any
 * client-side helper use one source of truth.
 */
import { HID_MODIFIER } from './constants'

export interface HidReport {
  modifier: number
  /** HID usage codes, up to 6. */
  keys: number[]
}

/** Modifier name (lowercased) → HID modifier bit. */
const MODIFIERS: Record<string, number> = {
  ctrl: HID_MODIFIER.LeftCtrl,
  control: HID_MODIFIER.LeftCtrl,
  lctrl: HID_MODIFIER.LeftCtrl,
  rctrl: HID_MODIFIER.RightCtrl,
  shift: HID_MODIFIER.LeftShift,
  lshift: HID_MODIFIER.LeftShift,
  rshift: HID_MODIFIER.RightShift,
  alt: HID_MODIFIER.LeftAlt,
  lalt: HID_MODIFIER.LeftAlt,
  ralt: HID_MODIFIER.RightAlt,
  altgr: HID_MODIFIER.RightAlt,
  super: HID_MODIFIER.LeftGui,
  win: HID_MODIFIER.LeftGui,
  windows: HID_MODIFIER.LeftGui,
  cmd: HID_MODIFIER.LeftGui,
  meta: HID_MODIFIER.LeftGui,
  gui: HID_MODIFIER.LeftGui
}

/** Named (non-character) keys → HID usage code. Names are matched lowercased. */
const NAMED_KEYS: Record<string, number> = {
  return: 0x28,
  enter: 0x28,
  kp_enter: 0x58,
  escape: 0x29,
  esc: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  ' ': 0x2c,
  delete: 0x4c,
  del: 0x4c,
  insert: 0x49,
  home: 0x4a,
  end: 0x4d,
  pageup: 0x4b,
  prior: 0x4b,
  pagedown: 0x4e,
  next: 0x4e,
  right: 0x4f,
  left: 0x50,
  down: 0x51,
  up: 0x52,
  capslock: 0x39,
  printscreen: 0x46,
  print: 0x46,
  scrolllock: 0x47,
  pause: 0x48,
  menu: 0x65,
  apps: 0x65,
  numlock: 0x53,
  f1: 0x3a,
  f2: 0x3b,
  f3: 0x3c,
  f4: 0x3d,
  f5: 0x3e,
  f6: 0x3f,
  f7: 0x40,
  f8: 0x41,
  f9: 0x42,
  f10: 0x43,
  f11: 0x44,
  f12: 0x45
}

/** Character → { usage, shift } for the printable ASCII set (US layout). */
function charToUsage(ch: string): { usage: number; shift: boolean } | null {
  const code = ch.codePointAt(0)
  if (code === undefined) return null

  if (ch >= 'a' && ch <= 'z') return { usage: 0x04 + (code - 97), shift: false }
  if (ch >= 'A' && ch <= 'Z') return { usage: 0x04 + (code - 65), shift: true }
  if (ch >= '1' && ch <= '9') return { usage: 0x1e + (code - 49), shift: false }
  if (ch === '0') return { usage: 0x27, shift: false }

  const map: Record<string, { usage: number; shift: boolean }> = {
    '\n': { usage: 0x28, shift: false },
    '\r': { usage: 0x28, shift: false },
    '\t': { usage: 0x2b, shift: false },
    ' ': { usage: 0x2c, shift: false },
    '-': { usage: 0x2d, shift: false },
    '_': { usage: 0x2d, shift: true },
    '=': { usage: 0x2e, shift: false },
    '+': { usage: 0x2e, shift: true },
    '[': { usage: 0x2f, shift: false },
    '{': { usage: 0x2f, shift: true },
    ']': { usage: 0x30, shift: false },
    '}': { usage: 0x30, shift: true },
    '\\': { usage: 0x31, shift: false },
    '|': { usage: 0x31, shift: true },
    ';': { usage: 0x33, shift: false },
    ':': { usage: 0x33, shift: true },
    "'": { usage: 0x34, shift: false },
    '"': { usage: 0x34, shift: true },
    '`': { usage: 0x35, shift: false },
    '~': { usage: 0x35, shift: true },
    ',': { usage: 0x36, shift: false },
    '<': { usage: 0x36, shift: true },
    '.': { usage: 0x37, shift: false },
    '>': { usage: 0x37, shift: true },
    '/': { usage: 0x38, shift: false },
    '?': { usage: 0x38, shift: true },
    '!': { usage: 0x1e, shift: true },
    '@': { usage: 0x1f, shift: true },
    '#': { usage: 0x20, shift: true },
    $: { usage: 0x21, shift: true },
    '%': { usage: 0x22, shift: true },
    '^': { usage: 0x23, shift: true },
    '&': { usage: 0x24, shift: true },
    '*': { usage: 0x25, shift: true },
    '(': { usage: 0x26, shift: true },
    ')': { usage: 0x27, shift: true }
  }
  return map[ch] ?? null
}

/** Resolve a single non-modifier token to a HID usage (named key or char). */
function tokenToUsage(token: string): { usage: number; shift: boolean } | null {
  const named = NAMED_KEYS[token.toLowerCase()]
  if (named !== undefined) return { usage: named, shift: false }
  if (token.length === 1) return charToUsage(token)
  return null
}

/**
 * Parse a key combo like "ctrl+alt+Delete" or "shift+F10" or "Return" into a
 * single HID report (all keys pressed together). Unknown tokens are ignored but
 * logged by the caller if the whole combo resolves to nothing.
 */
export function keyComboToReport(combo: string): HidReport {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  let modifier = 0
  const keys: number[] = []
  let shiftFromChar = false
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()]
    if (mod !== undefined) {
      modifier |= mod
      continue
    }
    const resolved = tokenToUsage(part)
    if (resolved) {
      if (resolved.shift) shiftFromChar = true
      if (keys.length < 6) keys.push(resolved.usage)
    }
  }
  if (shiftFromChar) modifier |= HID_MODIFIER.LeftShift
  return { modifier, keys }
}

/**
 * Convert text into a sequence of single-key HID reports (one keystroke each).
 * The caller sends each report followed by a key-release (empty report).
 */
export function textToReports(text: string): HidReport[] {
  const reports: HidReport[] = []
  for (const ch of text) {
    const resolved = charToUsage(ch)
    if (!resolved) continue
    reports.push({
      modifier: resolved.shift ? HID_MODIFIER.LeftShift : 0,
      keys: [resolved.usage]
    })
  }
  return reports
}

/** The empty report used to release all keys. */
export const RELEASE_REPORT: HidReport = { modifier: 0, keys: [] }

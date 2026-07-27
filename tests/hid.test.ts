import { describe, it, expect } from 'vitest'
import { keyComboToReport, textToReports } from '../src/shared/hid'
import { HID_MODIFIER } from '../src/shared/constants'

describe('HID keymap', () => {
  it('maps ctrl+alt+delete to modifiers + Delete usage', () => {
    const r = keyComboToReport('ctrl+alt+delete')
    expect(r.modifier).toBe(HID_MODIFIER.LeftCtrl | HID_MODIFIER.LeftAlt)
    expect(r.keys).toEqual([0x4c])
  })

  it('maps shift+F10 (WinRE command prompt)', () => {
    const r = keyComboToReport('shift+F10')
    expect(r.modifier).toBe(HID_MODIFIER.LeftShift)
    expect(r.keys).toEqual([0x43])
  })

  it('maps boot-menu function keys', () => {
    expect(keyComboToReport('F12').keys).toEqual([0x45])
    expect(keyComboToReport('Escape').keys).toEqual([0x29])
    expect(keyComboToReport('Delete').keys).toEqual([0x4c])
  })

  it('adds shift for shifted characters', () => {
    const r = keyComboToReport('!')
    expect(r.modifier & HID_MODIFIER.LeftShift).toBeTruthy()
    expect(r.keys).toEqual([0x1e]) // same usage as '1'
  })

  it('turns text into per-key reports with correct shift state', () => {
    const reports = textToReports('Ab')
    expect(reports).toHaveLength(2)
    expect(reports[0]).toEqual({ modifier: HID_MODIFIER.LeftShift, keys: [0x04] })
    expect(reports[1]).toEqual({ modifier: 0, keys: [0x05] })
  })

  it('caps a report at 6 keys', () => {
    const r = keyComboToReport('a+b+c+d+e+f+g+h')
    expect(r.keys.length).toBeLessThanOrEqual(6)
  })
})

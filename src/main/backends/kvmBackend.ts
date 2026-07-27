import { createLogger } from '../logger'
import { kvmBridge } from '../kvmBridge'
import { keyComboToReport } from '@shared/hid'
import {
  COMPUTER_USE_BETA,
  COMPUTER_USE_TOOL_TYPE,
  KVM_ABS_MAX,
  KVM_MOUSE_BUTTON,
  MODEL_DISPLAY_HEIGHT,
  MODEL_DISPLAY_WIDTH
} from '@shared/constants'
import type { KvmActionPayload, KvmCommandResult } from '@shared/ipc-contract'
import type { CapturedFrame, KvmSettings, TargetMode } from '@shared/types'
import type {
  PerceiveResult,
  RenderedAction,
  TargetBackend,
  ToolExecResult,
  ToolInvocation
} from './types'

const logger = createLogger('kvm-backend')

function clampAbs(v: number): number {
  return Math.max(0, Math.min(KVM_ABS_MAX, Math.round(v)))
}

/**
 * KVM backend — perception is screenshots over WebRTC, action is JetKVM HID.
 * Vision is the only channel, which is the nature of a KVM. The renderer owns
 * the WebRTC/RPC connection; this backend talks to it via the KvmBridge.
 */
export class KvmBackend implements TargetBackend {
  readonly mode: TargetMode = 'kvm'
  readonly supportsReboot = true
  private lastFrame: { width: number; height: number } | null = null

  constructor(private settings: KvmSettings) {}

  async connect(): Promise<void> {
    const res = await kvmBridge.send({ type: 'connect', settings: this.settings }, 45_000)
    if (!res.ok) throw new Error(res.error)
  }

  async dispose(): Promise<void> {
    await kvmBridge.send({ type: 'disconnect' }, 5_000)
  }

  tools(): Record<string, unknown>[] {
    return [
      {
        type: COMPUTER_USE_TOOL_TYPE,
        name: 'computer',
        display_width_px: this.lastFrame?.width ?? MODEL_DISPLAY_WIDTH,
        display_height_px: this.lastFrame?.height ?? MODEL_DISPLAY_HEIGHT,
        display_number: 1
      }
    ]
  }

  betas(): string[] {
    return [COMPUTER_USE_BETA]
  }

  systemHint(): string {
    return (
      'You are controlling a physical Windows machine through a KVM. Your only ' +
      'channel is vision: take a screenshot, then click, type, or press keys. ' +
      'After each action take a screenshot and verify the result before the next ' +
      'step. Boot-menu and BIOS keys must be pressed at the right moment — say ' +
      'which key and when, and the orchestrator handles precise timing. Never ' +
      'assume an action worked without a screenshot confirming it.'
    )
  }

  async perceive(): Promise<PerceiveResult> {
    const frame = await this.capture()
    if (!frame) return { text: 'No video frame available yet from the KVM.' }
    return {
      text: 'Current screen of the target machine is attached.',
      imageBase64: frame.jpegBase64,
      imageMediaType: 'image/jpeg'
    }
  }

  async watchFrame(): Promise<PerceiveResult> {
    const frame = await this.capture()
    if (!frame) return { text: 'No frame.' }
    return { text: 'Screen frame.', imageBase64: frame.jpegBase64, imageMediaType: 'image/jpeg' }
  }

  renderAction(inv: ToolInvocation): RenderedAction {
    const action = String(inv.input.action ?? 'unknown')
    const coord = Array.isArray(inv.input.coordinate) ? (inv.input.coordinate as number[]) : null
    const at = coord ? ` at (${coord[0]}, ${coord[1]})` : ''
    switch (action) {
      case 'screenshot':
        return { kind: 'note', summary: 'Take a screenshot', detail: 'screenshot' }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click':
        return { kind: 'kvm_click', summary: `${action.replace('_', ' ')}${at}`, detail: `${action}${at}` }
      case 'left_click_drag':
        return { kind: 'kvm_click', summary: `drag${at}`, detail: `left_click_drag${at}` }
      case 'left_mouse_down':
      case 'left_mouse_up':
        return { kind: 'kvm_click', summary: `${action.replace(/_/g, ' ')}${at}`, detail: `${action}${at}` }
      case 'mouse_move':
        return { kind: 'kvm_move', summary: `move mouse${at}`, detail: `mouse_move${at}` }
      case 'type': {
        const text = String(inv.input.text ?? '')
        return { kind: 'kvm_type', summary: `Type "${truncate(text, 40)}"`, detail: text }
      }
      case 'key':
      case 'hold_key': {
        const text = String(inv.input.text ?? '')
        return { kind: 'kvm_key', summary: `Press ${text}`, detail: text }
      }
      case 'scroll': {
        const dir = String(inv.input.scroll_direction ?? '')
        const amt = String(inv.input.scroll_amount ?? '')
        return { kind: 'kvm_scroll', summary: `scroll ${dir} ${amt}${at}`, detail: `scroll ${dir} ${amt}` }
      }
      case 'wait':
        return { kind: 'wait', summary: 'wait', detail: `wait ${String(inv.input.duration ?? '')}` }
      default:
        return { kind: 'note', summary: action, detail: JSON.stringify(inv.input) }
    }
  }

  async execute(inv: ToolInvocation): Promise<ToolExecResult> {
    const action = String(inv.input.action ?? 'unknown')
    const log: string[] = []

    if (action === 'screenshot') {
      const frame = await this.capture()
      if (!frame) return this.err('Could not capture a screenshot from the KVM.', log)
      log.push('Captured screenshot')
      return {
        resultText: 'Screenshot captured.',
        imageBase64: frame.jpegBase64,
        imageMediaType: 'image/jpeg',
        actionLog: log
      }
    }

    const payload = this.toPayload(action, inv.input, log)
    if (!payload) {
      return { resultText: `Unsupported or empty action: ${action}`, isError: true, actionLog: log }
    }

    const res = await kvmBridge.send({ type: 'action', action: payload })
    if (!res.ok) return this.err(res.error, log)

    // After every action, grab a fresh frame so the model sees the result.
    const frame = await this.capture()
    if (frame) {
      return { resultText: `Executed ${action}. New screenshot attached.`, imageBase64: frame.jpegBase64, imageMediaType: 'image/jpeg', actionLog: log }
    }
    return { resultText: `Executed ${action}.`, actionLog: log }
  }

  async reboot(): Promise<void> {
    logger.info('Rebooting target via Ctrl+Alt+Del')
    const report = keyComboToReport('ctrl+alt+delete')
    const res = await kvmBridge.send({ type: 'action', action: { kind: 'key', report } })
    if (!res.ok) {
      logger.warn(`Ctrl+Alt+Del failed: ${res.error}. The machine may be hard-frozen.`)
      throw new Error(res.error)
    }
  }

  /** Mount a Windows ISO over HTTP as USB media (used to reach a command line). */
  async mountIso(url: string, mode = 'cdrom'): Promise<KvmCommandResult> {
    return kvmBridge.send({ type: 'action', action: { kind: 'mountIso', url, mode } }, 60_000)
  }

  // --- helpers -------------------------------------------------------------

  private async capture(): Promise<CapturedFrame | null> {
    const res = await kvmBridge.send({ type: 'capture' }, 15_000)
    if (!res.ok || !res.frame) return null
    this.lastFrame = { width: res.frame.width, height: res.frame.height }
    return res.frame
  }

  private absFromModel(x: number, y: number): { x: number; y: number } {
    const fw = this.lastFrame?.width ?? MODEL_DISPLAY_WIDTH
    const fh = this.lastFrame?.height ?? MODEL_DISPLAY_HEIGHT
    return { x: clampAbs((x / fw) * KVM_ABS_MAX), y: clampAbs((y / fh) * KVM_ABS_MAX) }
  }

  private buttonFor(action: string): number {
    if (action.startsWith('right')) return KVM_MOUSE_BUTTON.Right
    if (action.startsWith('middle')) return KVM_MOUSE_BUTTON.Middle
    return KVM_MOUSE_BUTTON.Left
  }

  private toPayload(action: string, input: Record<string, unknown>, log: string[]): KvmActionPayload | null {
    const coord = Array.isArray(input.coordinate) ? (input.coordinate as number[]) : null
    const modifierText = typeof input.text === 'string' ? input.text : ''

    const clickCount = action.startsWith('double') ? 2 : action.startsWith('triple') ? 3 : 1

    switch (action) {
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        if (!coord) return null
        const { x, y } = this.absFromModel(coord[0]!, coord[1]!)
        const modifier = action === 'left_click' && modifierText ? keyComboToReport(modifierText).modifier : 0
        log.push(`${action} at model(${coord[0]},${coord[1]}) → abs(${x},${y})`)
        return { kind: 'clickAbs', x, y, button: this.buttonFor(action), count: clickCount, modifier }
      }
      case 'mouse_move': {
        if (!coord) return null
        const { x, y } = this.absFromModel(coord[0]!, coord[1]!)
        log.push(`move to abs(${x},${y})`)
        return { kind: 'moveAbs', x, y }
      }
      case 'left_click_drag': {
        const start = Array.isArray(input.start_coordinate) ? (input.start_coordinate as number[]) : null
        if (!start || !coord) return null
        const a = this.absFromModel(start[0]!, start[1]!)
        const b = this.absFromModel(coord[0]!, coord[1]!)
        log.push(`drag abs(${a.x},${a.y})→(${b.x},${b.y})`)
        return { kind: 'dragAbs', x1: a.x, y1: a.y, x2: b.x, y2: b.y, button: KVM_MOUSE_BUTTON.Left }
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        if (!coord) return null
        const { x, y } = this.absFromModel(coord[0]!, coord[1]!)
        return { kind: 'mouseButton', x, y, button: KVM_MOUSE_BUTTON.Left, down: action === 'left_mouse_down' }
      }
      case 'type': {
        const text = String(input.text ?? '')
        log.push(`type ${text.length} chars`)
        return { kind: 'type', text }
      }
      case 'key': {
        const report = keyComboToReport(String(input.text ?? ''))
        if (report.keys.length === 0 && report.modifier === 0) return null
        log.push(`key ${String(input.text)}`)
        return { kind: 'key', report }
      }
      case 'hold_key': {
        const report = keyComboToReport(String(input.text ?? ''))
        const durationMs = Math.round(Number(input.duration ?? 1) * 1000)
        log.push(`hold ${String(input.text)} for ${durationMs}ms`)
        return { kind: 'holdKey', report, durationMs }
      }
      case 'scroll': {
        const dir = String(input.scroll_direction ?? 'down')
        const amount = Number(input.scroll_amount ?? 3)
        let wheelY = 0
        let wheelX = 0
        if (dir === 'down') wheelY = -amount
        else if (dir === 'up') wheelY = amount
        else if (dir === 'left') wheelX = -amount
        else if (dir === 'right') wheelX = amount
        const pos = coord ? this.absFromModel(coord[0]!, coord[1]!) : undefined
        log.push(`scroll ${dir} ${amount}`)
        return { kind: 'scroll', wheelY, wheelX, x: pos?.x, y: pos?.y }
      }
      case 'wait':
        // Waiting is handled by the orchestrator's timing primitives; treat as
        // a short no-op so the model can pace itself.
        return { kind: 'rpc', method: 'ping', params: {} }
      default:
        return null
    }
  }

  private err(message: string, log: string[]): ToolExecResult {
    return { resultText: `Error: ${message}`, isError: true, actionLog: [...log, `error: ${message}`] }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

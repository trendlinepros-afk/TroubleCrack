import { RELEASE_REPORT, textToReports, type HidReport } from '@shared/hid'
import { KVM_ABS_MAX } from '@shared/constants'
import type { KvmActionPayload, KvmCommand, KvmCommandResult } from '@shared/ipc-contract'
import type { CapturedFrame, ConnectionStatus } from '@shared/types'
import { attachManualControl, detachManualControl } from './manualControl'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30_000

/**
 * Renderer-side JetKVM client. Chromium speaks WebRTC natively, so the renderer
 * owns the video track and the JSON-RPC data channel; the main process handles
 * the HTTP signaling (login + /webrtc/session). Commands from the orchestrator
 * arrive over the KVM bridge; results go back the same way.
 */
export class KvmClient {
  private pc: RTCPeerConnection | null = null
  private rpc: RTCDataChannel | null = null
  private videoEl: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private rpcId = 1
  private manual = false
  private reconnectAttempt = 0
  private reconnecting = false
  private disposed = false
  private wantConnected = false
  private onStatus: (s: ConnectionStatus) => void

  constructor(onStatus: (s: ConnectionStatus) => void) {
    this.onStatus = onStatus
  }

  setVideoElement(el: HTMLVideoElement | null): void {
    this.videoEl = el
    if (el && this.stream) el.srcObject = this.stream
    if (el && this.manual) attachManualControl(el, (p) => void this.executeAction(p))
  }

  private status(phase: ConnectionStatus['phase'], detail: string): void {
    this.onStatus({ phase, detail, since: Date.now(), attempt: this.reconnectAttempt })
  }

  /** Handle a command from the orchestrator (via the KVM bridge). */
  async handleCommand(cmd: KvmCommand): Promise<KvmCommandResult> {
    try {
      switch (cmd.type) {
        case 'connect':
          this.wantConnected = true
          await this.connect()
          return { ok: true }
        case 'disconnect':
          this.wantConnected = false
          this.teardown()
          this.status('disconnected', 'Disconnected')
          return { ok: true }
        case 'capture': {
          const frame = this.capture()
          return frame ? { ok: true, frame } : { ok: false, error: 'No video frame available' }
        }
        case 'action':
          await this.executeAction(cmd.action)
          return { ok: true }
        case 'setManual':
          this.setManual(cmd.enabled)
          return { ok: true }
        case 'ping':
          return { ok: true }
        default:
          return { ok: false, error: 'Unknown command' }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // --- connection ----------------------------------------------------------

  private async connect(): Promise<void> {
    this.teardown()
    this.status('connecting', 'Finding the JetKVM…')

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
    this.pc = pc

    this.rpc = pc.createDataChannel('rpc', { ordered: true })
    this.rpc.onopen = () => this.status('connected', 'Connected')

    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })

    pc.ontrack = (ev) => {
      this.stream = ev.streams[0] ?? new MediaStream([ev.track])
      if (this.videoEl) {
        this.videoEl.srcObject = this.stream
        void this.videoEl.play().catch(() => undefined)
      }
    }

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      if ((s === 'disconnected' || s === 'failed') && this.wantConnected) {
        this.scheduleReconnect()
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.waitIceGathering(pc)

    this.status('negotiating', 'Negotiating session…')
    const offerB64 = btoa(JSON.stringify(pc.localDescription))
    // Main resolves the device's current IP (discovery), logs in, and posts the
    // offer to /webrtc/session — the renderer never handles the address.
    const result = await window.api.kvmSignal(offerB64)
    if (!result.ok) throw new Error(result.error)

    const answer = JSON.parse(atob(result.answerB64)) as RTCSessionDescriptionInit
    await pc.setRemoteDescription(answer)

    await this.waitConnected(pc, 20_000)
    this.reconnectAttempt = 0
    this.status('connected', 'Connected')
  }

  private waitIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
      const check = (): void => {
        if (pc.iceGatheringState === 'complete') done()
      }
      pc.addEventListener('icegatheringstatechange', check)
      // Don't wait forever for relay candidates on a LAN — 3s is plenty.
      setTimeout(done, 3000)
    })
  }

  private waitConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    if (pc.connectionState === 'connected') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out establishing the WebRTC connection.'))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        pc.removeEventListener('connectionstatechange', check)
      }
      const check = (): void => {
        if (pc.connectionState === 'connected') {
          cleanup()
          resolve()
        } else if (pc.connectionState === 'failed') {
          cleanup()
          reject(new Error('WebRTC connection failed.'))
        }
      }
      pc.addEventListener('connectionstatechange', check)
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.disposed || !this.wantConnected) return
    this.reconnecting = true
    this.reconnectAttempt += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS)
    this.status('reconnecting', `Connection lost — reconnecting (attempt ${this.reconnectAttempt})…`)
    setTimeout(() => {
      void this.connect()
        .then(() => {
          this.reconnecting = false
        })
        .catch(() => {
          this.reconnecting = false
          if (this.wantConnected) this.scheduleReconnect()
        })
    }, delay)
  }

  private teardown(): void {
    try {
      this.rpc?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close()
    } catch {
      /* ignore */
    }
    this.rpc = null
    this.pc = null
  }

  dispose(): void {
    this.disposed = true
    this.wantConnected = false
    this.teardown()
  }

  // --- capture -------------------------------------------------------------

  private capture(): CapturedFrame | null {
    const v = this.videoEl
    if (!v || v.videoWidth === 0 || v.videoHeight === 0) return null
    const nativeWidth = v.videoWidth
    const nativeHeight = v.videoHeight
    const scale = Math.min(1, 1280 / nativeWidth, 800 / nativeHeight)
    const width = Math.max(1, Math.round(nativeWidth * scale))
    const height = Math.max(1, Math.round(nativeHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(v, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    const jpegBase64 = dataUrl.split(',')[1] ?? ''
    return { jpegBase64, width, height, nativeWidth, nativeHeight }
  }

  // --- manual control ------------------------------------------------------

  private setManual(enabled: boolean): void {
    this.manual = enabled
    if (!this.videoEl) return
    if (enabled) attachManualControl(this.videoEl, (p) => void this.executeAction(p))
    else detachManualControl(this.videoEl)
  }

  // --- HID / actions -------------------------------------------------------

  private send(method: string, params: Record<string, unknown>): void {
    if (!this.rpc || this.rpc.readyState !== 'open') return
    this.rpc.send(JSON.stringify({ jsonrpc: '2.0', method, params, id: this.rpcId++ }))
  }

  private key(report: HidReport): void {
    this.send('keyboardReport', { modifier: report.modifier, keys: report.keys })
  }

  private release(): void {
    this.send('keyboardReport', { modifier: RELEASE_REPORT.modifier, keys: RELEASE_REPORT.keys })
  }

  private absMouse(x: number, y: number, buttons: number): void {
    this.send('absMouseReport', { x, y, buttons })
  }

  async executeAction(a: KvmActionPayload): Promise<void> {
    switch (a.kind) {
      case 'key':
        this.key(a.report)
        await sleep(30)
        this.release()
        break
      case 'keySequence':
        for (const r of a.reports) {
          this.key(r)
          await sleep(a.interKeyMs ?? 20)
          this.release()
          await sleep(a.interKeyMs ?? 20)
        }
        break
      case 'holdKey':
        this.key(a.report)
        await sleep(a.durationMs)
        this.release()
        break
      case 'type':
        for (const r of textToReports(a.text)) {
          this.key(r)
          await sleep(8)
          this.release()
          await sleep(8)
        }
        break
      case 'clickAbs': {
        if (a.modifier) this.key({ modifier: a.modifier, keys: [] })
        this.absMouse(a.x, a.y, 0)
        await sleep(15)
        const count = a.count ?? 1
        for (let i = 0; i < count; i++) {
          this.absMouse(a.x, a.y, a.button)
          await sleep(20)
          this.absMouse(a.x, a.y, 0)
          await sleep(20)
        }
        if (a.modifier) this.release()
        break
      }
      case 'moveAbs':
        this.absMouse(a.x, a.y, 0)
        break
      case 'dragAbs':
        this.absMouse(a.x1, a.y1, 0)
        await sleep(20)
        this.absMouse(a.x1, a.y1, a.button)
        await sleep(40)
        this.absMouse(a.x2, a.y2, a.button)
        await sleep(40)
        this.absMouse(a.x2, a.y2, 0)
        break
      case 'mouseButton':
        this.absMouse(a.x, a.y, a.down ? a.button : 0)
        break
      case 'scroll':
        if (a.x !== undefined && a.y !== undefined) {
          this.absMouse(a.x, a.y, 0)
          await sleep(10)
        }
        this.send('wheelReport', { wheelY: a.wheelY, wheelX: a.wheelX })
        break
      case 'spamKey': {
        const end = performance.now() + a.durationMs
        while (performance.now() < end) {
          this.key(a.report)
          await sleep(Math.max(5, Math.floor(a.intervalMs / 2)))
          this.release()
          await sleep(Math.max(5, Math.ceil(a.intervalMs / 2)))
        }
        break
      }
      case 'mountIso':
        this.send('mountWithHTTP', { url: a.url, mode: a.mode })
        break
      case 'rpc':
        this.send(a.method, a.params)
        break
      default:
        break
    }
  }
}

export { KVM_ABS_MAX }

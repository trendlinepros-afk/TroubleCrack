import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-contract'
import type {
  KvmCommand,
  KvmCommandResult,
  KvmReplyEnvelope
} from '@shared/ipc-contract'
import type { ConnectionStatus } from '@shared/types'
import { createLogger } from './logger'

const logger = createLogger('kvm-bridge')

interface Pending {
  resolve: (r: KvmCommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Request/response bridge from the main-process orchestrator to the renderer's
 * KvmClient. The renderer owns the WebRTC connection (Chromium speaks WebRTC
 * natively); main sends commands and awaits results here.
 */
export class KvmBridge {
  private wc: WebContents | null = null
  private pending = new Map<string, Pending>()
  private status: ConnectionStatus = {
    phase: 'disconnected',
    detail: 'Not connected',
    since: Date.now()
  }
  private statusListeners = new Set<(s: ConnectionStatus) => void>()

  attach(wc: WebContents): void {
    this.wc = wc
  }

  detach(): void {
    this.wc = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'Renderer detached' })
    }
    this.pending.clear()
  }

  /** Called by the IPC layer when the renderer posts a reply. */
  handleReply(env: KvmReplyEnvelope): void {
    const p = this.pending.get(env.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(env.id)
    p.resolve(env.result)
  }

  /** Called by the IPC layer when the renderer reports connection status. */
  handleStatus(status: ConnectionStatus): void {
    this.status = status
    for (const fn of this.statusListeners) fn(status)
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  currentStatus(): ConnectionStatus {
    return this.status
  }

  send(cmd: KvmCommand, timeoutMs = 20_000): Promise<KvmCommandResult> {
    if (!this.wc || this.wc.isDestroyed()) {
      return Promise.resolve({ ok: false, error: 'Renderer not available' })
    }
    const id = randomUUID()
    return new Promise<KvmCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        logger.warn(`KVM command ${cmd.type} timed out after ${timeoutMs}ms`)
        resolve({ ok: false, error: `KVM command "${cmd.type}" timed out` })
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.wc!.send(CH.evKvmCommand, { id, cmd })
    })
  }
}

export const kvmBridge = new KvmBridge()

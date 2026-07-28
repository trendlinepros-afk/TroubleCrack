import { JsonStore } from '../store'
import { createLogger } from '../logger'
import { AnthropicService } from '../anthropic/client'
import { KvmBackend } from '../backends/kvmBackend'
import { LocalBackend } from '../backends/localBackend'
import { VaultService } from '../vault'
import { RepairSession } from './session'
import { getApiKeyPlaintext, loadSettings } from '../settings'
import { autoExportSummary } from '../sessionExport'
import type {
  ApprovalDecision,
  ApprovalMode,
  SessionSnapshot,
  StartSessionInput
} from '@shared/types'

const logger = createLogger('session-manager')

/**
 * Owns the single active RepairSession, persists its snapshot continuously, and
 * routes all session IPC. Also handles "idle chat" — describing a problem when
 * no session is running, so the agent can offer to start a Local session.
 */
class SessionManager {
  private session: RepairSession | null = null
  private lastSnapshot: SessionSnapshot | null = null
  private store = new JsonStore<SessionSnapshot | null>('session.json', null)
  private broadcast: ((s: SessionSnapshot) => void) | null = null

  /** Restore the last snapshot on startup (display only — never auto-resumes). */
  init(): void {
    const restored = this.store.read()
    if (restored) {
      if (restored.runState === 'running' || restored.runState === 'paused') {
        restored.runState = 'stopped'
        restored.narration.push({
          id: `${Date.now()}`,
          ts: Date.now(),
          kind: 'warn',
          text: 'This session was interrupted when the app closed. Start a new session to continue.'
        })
      }
      this.lastSnapshot = restored
      logger.info('Restored previous session snapshot from disk')
    }
  }

  setBroadcaster(fn: ((s: SessionSnapshot) => void) | null): void {
    this.broadcast = fn
  }

  getSnapshot(): SessionSnapshot | null {
    return this.session?.getSnapshot() ?? this.lastSnapshot
  }

  isBusy(): boolean {
    const s = this.session?.getSnapshot()
    return s?.runState === 'running' || s?.runState === 'paused'
  }

  async start(input: StartSessionInput): Promise<SessionSnapshot> {
    if (this.isBusy()) throw new Error('A repair session is already running. Stop it first.')

    const settings = loadSettings()
    const apiKey = getApiKeyPlaintext()
    if (!apiKey) throw new Error('Set an Anthropic API key in Settings before starting a session.')

    const anthropic = new AnthropicService(apiKey, settings.model)
    // The KVM backend holds no address — the renderer/main resolve the device's
    // current IP via discovery at connect time.
    const backend = input.mode === 'kvm' ? new KvmBackend() : new LocalBackend()
    const vault = new VaultService(settings.vaultPath)

    const session = new RepairSession(input, anthropic, backend, vault, settings.caps, {
      onSnapshot: (s) => this.onSnapshot(s),
      onFinished: (s) => this.onFinished(s)
    })
    this.session = session
    logger.info(`Starting ${input.mode} session ${session.id}`)
    void session.run().catch((err) => {
      logger.error('Session run loop crashed', err)
    })
    return session.getSnapshot()
  }

  pause(): void {
    this.session?.pause()
  }

  resume(): void {
    this.session?.resume()
  }

  stop(): void {
    this.session?.stop()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.session?.setApprovalMode(mode)
  }

  async setManualControl(enabled: boolean): Promise<void> {
    await this.session?.setManualControl(enabled)
  }

  submitApproval(actionId: string, decision: ApprovalDecision): void {
    this.session?.submitApproval(actionId, decision)
  }

  async sendChat(text: string): Promise<void> {
    if (this.session && this.isBusy()) {
      await this.session.sendChat(text)
    }
  }

  async idleChat(text: string): Promise<{ reply: string; suggestLocalSession: boolean }> {
    if (this.session && this.isBusy()) {
      await this.session.sendChat(text)
      return { reply: '', suggestLocalSession: false }
    }
    const settings = loadSettings()
    const apiKey = getApiKeyPlaintext()
    if (!apiKey) {
      return {
        reply: 'Add an Anthropic API key in Settings and I can help troubleshoot this.',
        suggestLocalSession: false
      }
    }
    try {
      const anthropic = new AnthropicService(apiKey, settings.model)
      const reply = await anthropic.summarize(
        'You are TroubleCrack. The administrator described a problem with their own ' +
          'computer while no repair session is running. Briefly say what you would ' +
          'check and offer to start a Local-mode repair session on this computer.',
        `The administrator said: "${text}". Reply in 2-3 sentences and end by offering ` +
          'to start a Local session.'
      )
      return { reply: reply || 'I can start a Local-mode session on this computer to look into that.', suggestLocalSession: true }
    } catch (err) {
      logger.warn('Idle chat reply failed')
      return {
        reply: 'I can start a Local-mode session on this computer to troubleshoot that.',
        suggestLocalSession: true
      }
    }
  }

  private onSnapshot(s: SessionSnapshot): void {
    this.lastSnapshot = s
    void this.store.write(s)
    this.broadcast?.(s)
  }

  private onFinished(s: SessionSnapshot): void {
    this.lastSnapshot = s
    void this.store.write(s)
    this.broadcast?.(s)
    logger.info(`Session ${s.id} finished: ${s.orchestratorState} / ${s.runState}`)
    void this.autoExport(s)
  }

  /** Write a summary automatically when a session ends, then note where it went
   *  in the feed. Best-effort — a failed export never disturbs the session. */
  private async autoExport(s: SessionSnapshot): Promise<void> {
    try {
      const savedPath = await autoExportSummary(s)
      if (!savedPath) return
      s.narration.push({
        id: `${Date.now()}-export`,
        ts: Date.now(),
        kind: 'info',
        text: `📄 Summary saved to ${savedPath}`
      })
      s.updatedAt = Date.now()
      this.lastSnapshot = s
      void this.store.write(s)
      this.broadcast?.(s)
    } catch (err) {
      logger.warn('Auto-export follow-up failed')
    }
  }
}

export const sessionManager = new SessionManager()

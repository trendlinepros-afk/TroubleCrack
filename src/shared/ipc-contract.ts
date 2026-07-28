/**
 * IPC contract: channel names, the KVM command bridge protocol, and the typed
 * `TroubleCrackApi` surface the preload exposes on `window.api`.
 */
import type {
  ApprovalDecision,
  ApprovalMode,
  CapturedFrame,
  ConnectionStatus,
  DiscoveredDevice,
  ElevationStatus,
  KvmSettings,
  LogEvent,
  Settings,
  SettingsPatch,
  SettingsValidation,
  SessionSnapshot,
  StartSessionInput,
  UpdateStatus
} from './types'

// --- Channel names (renderer → main, invoke/handle) ------------------------
export const CH = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  validateSettings: 'settings:validate',
  getElevation: 'system:elevation',
  relaunchAsAdmin: 'system:relaunch-admin',
  getAppVersion: 'system:app-version',
  pickDirectory: 'system:pick-directory',
  startSession: 'session:start',
  pauseSession: 'session:pause',
  resumeSession: 'session:resume',
  stopSession: 'session:stop',
  setApprovalMode: 'session:set-approval-mode',
  setManualControl: 'session:set-manual',
  submitApproval: 'session:approval',
  sendChat: 'session:chat',
  idleChat: 'session:idle-chat',
  getSnapshot: 'session:snapshot',
  checkForUpdates: 'update:check',
  quitAndInstall: 'update:install',
  // renderer → main (invoke): device discovery + target selection
  discoverDevices: 'kvm:discover',
  selectKvmTarget: 'kvm:select-target',
  forgetKvmTarget: 'kvm:forget',
  // renderer → main (invoke): WebRTC signaling (resolve IP + login + session POST)
  kvmSignal: 'kvm:signal',
  // renderer → main (send): KVM bridge replies + status
  kvmReply: 'kvm:reply',
  kvmStatus: 'kvm:status',
  // main → renderer (send): events
  evKvmCommand: 'kvm:command',
  evSessionUpdate: 'ev:session',
  evConnectionUpdate: 'ev:connection',
  evLog: 'ev:log',
  evUpdateStatus: 'ev:update',
  evMenuAction: 'ev:menu'
} as const

/** Actions the native application menu asks the renderer to perform. */
export type MenuAction = 'open-settings' | 'new-session'

// --- KVM command bridge (main → renderer request/response) -----------------

export interface KvmReport {
  modifier: number
  keys: number[]
}

export type KvmActionPayload =
  | { kind: 'key'; report: KvmReport }
  | { kind: 'keySequence'; reports: KvmReport[]; interKeyMs?: number }
  | { kind: 'holdKey'; report: KvmReport; durationMs: number }
  | { kind: 'type'; text: string }
  | { kind: 'clickAbs'; x: number; y: number; button: number; count?: number; modifier?: number }
  | { kind: 'moveAbs'; x: number; y: number }
  | { kind: 'dragAbs'; x1: number; y1: number; x2: number; y2: number; button: number }
  | { kind: 'mouseButton'; x: number; y: number; button: number; down: boolean }
  | { kind: 'scroll'; x?: number; y?: number; wheelY: number; wheelX: number; modifier?: number }
  | { kind: 'spamKey'; report: KvmReport; intervalMs: number; durationMs: number }
  | { kind: 'mountIso'; url: string; mode: string }
  | { kind: 'rpc'; method: string; params: Record<string, unknown> }

/** A crop of the native frame, as fractions 0..1 (for high-res zoom). */
export interface FrameRegion {
  fx1: number
  fy1: number
  fx2: number
  fy2: number
}

export type KvmCommand =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'capture'; region?: FrameRegion }
  | { type: 'action'; action: KvmActionPayload }
  | { type: 'setManual'; enabled: boolean }
  | { type: 'ping' }

export type KvmCommandResult =
  | { ok: true; frame?: CapturedFrame; data?: unknown }
  | { ok: false; error: string }

export interface KvmCommandEnvelope {
  id: string
  cmd: KvmCommand
}

/**
 * WebRTC signaling result. Main resolves the JetKVM's current IP (discovery),
 * logs in if needed, POSTs the offer to /webrtc/session, captures the stable
 * device id, and returns the answer. The renderer only supplies the offer.
 */
export type KvmSignalResult =
  | { ok: true; answerB64: string }
  | { ok: false; error: string; needsPicker?: boolean }

/** A manually-entered or picker-selected target for the next connect only. */
export interface KvmTargetSelection {
  /** IP or IP:port. Never persisted — used for the next connection only. */
  host: string
  useTls: boolean
}

export interface KvmReplyEnvelope {
  id: string
  result: KvmCommandResult
}

// --- The window.api surface ------------------------------------------------

export interface UpdateCheckResult {
  state: UpdateStatus['state']
  version?: string
  message?: string
}

export interface RelaunchResult {
  ok: boolean
  message: string
}

export interface TroubleCrackApi {
  // settings & system
  getSettings(): Promise<Settings>
  saveSettings(patch: SettingsPatch): Promise<Settings>
  validateSettings(input: {
    kvm: KvmSettings
    anthropicApiKeyPlaintext?: string | null
    vaultPath: string | null
  }): Promise<SettingsValidation>
  getElevation(): Promise<ElevationStatus>
  relaunchAsAdmin(): Promise<RelaunchResult>
  getAppVersion(): Promise<string>
  pickDirectory(): Promise<string | null>

  // session control
  startSession(input: StartSessionInput): Promise<SessionSnapshot>
  pauseSession(): Promise<void>
  resumeSession(): Promise<void>
  stopSession(): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setManualControl(enabled: boolean): Promise<void>
  submitApproval(actionId: string, decision: ApprovalDecision): Promise<void>
  sendChat(text: string): Promise<void>
  idleChat(text: string): Promise<{ reply: string; suggestLocalSession: boolean }>
  getSnapshot(): Promise<SessionSnapshot | null>

  // updates
  checkForUpdates(): Promise<UpdateCheckResult>
  quitAndInstall(): Promise<void>

  // Device discovery + target selection (IP is never persisted).
  discoverDevices(useTls: boolean): Promise<DiscoveredDevice[]>
  selectKvmTarget(selection: KvmTargetSelection): Promise<void>
  forgetKvmTarget(): Promise<void>

  // WebRTC signaling done in main (resolve IP + login + /webrtc/session).
  kvmSignal(offerB64: string): Promise<KvmSignalResult>

  // KVM bridge: renderer registers a handler main invokes; renderer replies.
  onKvmCommand(handler: (env: KvmCommandEnvelope) => void): () => void
  replyKvmCommand(reply: KvmReplyEnvelope): void
  reportKvmStatus(status: ConnectionStatus): void

  // main → renderer events
  onSessionUpdate(cb: (s: SessionSnapshot) => void): () => void
  onConnectionUpdate(cb: (c: ConnectionStatus) => void): () => void
  onLog(cb: (e: LogEvent) => void): () => void
  onUpdateStatus(cb: (u: UpdateStatus) => void): () => void
  onMenuAction(cb: (action: MenuAction) => void): () => void
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    api: TroubleCrackApi
  }
}

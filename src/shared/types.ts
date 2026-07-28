/**
 * Shared domain types used across main, preload, and renderer. Kept
 * dependency-free so every layer can import them.
 */

export type TargetMode = 'kvm' | 'local'
export type ApprovalMode = 'approval' | 'auto'

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'negotiating'
  | 'connected'
  | 'reconnecting'
  | 'failed'

export interface ConnectionStatus {
  phase: ConnectionPhase
  /** Plain-English detail suitable for direct display. */
  detail: string
  since: number
  attempt?: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type KvmAuthMode = 'auto' | 'password' | 'noPassword'

/**
 * The JetKVM is identified by a STABLE identity (device id / `.local` hostname),
 * never by IP — the address is DHCP-assigned and this app moves between networks,
 * so the current IP is resolved fresh at connect time via discovery.
 */
export interface KvmSettings {
  /** Stable JetKVM device id (from the authenticated /device endpoint). */
  deviceId: string | null
  /** Friendly name for display. */
  deviceName: string | null
  /** The device's `.local` hostname (jetkvm-<id>.local) for mDNS re-resolution. */
  hostname: string | null
  useTls: boolean
  authMode: KvmAuthMode
  /** Only ever carries plaintext in-flight from the Settings form; at rest the
   *  password is held in the encrypted blob alongside the API key. */
  password: string
}

/** A JetKVM found by discovery. The `host` (IP) is ephemeral and never persisted. */
export interface DiscoveredDevice {
  /** Stable identity: device id if known, else `.local` hostname, else host:port. */
  id: string
  name: string
  /** Current IP — ephemeral, resolved fresh; never stored in settings. */
  host: string
  port: number
  useTls: boolean
  hostname: string | null
  deviceId: string | null
  isSetup: boolean | null
  source: 'mdns' | 'scan' | 'manual'
}

export interface Caps {
  maxIterations: number
  maxSpendUsd: number
  maxWallClockMs: number
}

export interface Settings {
  kvm: KvmSettings
  /** True when an Anthropic API key is stored (encrypted via safeStorage). The
   *  plaintext key never leaves the main process. */
  hasApiKey: boolean
  model: string
  vaultPath: string | null
  caps: Caps
  defaultApprovalMode: ApprovalMode
  /** GitHub repo "owner/name" used for auto-update, if configured. */
  updateRepo: string | null
  /** When true, a Markdown summary is written automatically when a session ends. */
  autoExportSummary: boolean
  /** Folder for auto-exported summaries; null means use the default location. */
  summaryExportDir: string | null
  /** The resolved default folder (read-only; shown when summaryExportDir is null). */
  summaryExportDirDefault: string
}

/** Patch shape accepted by saveSettings. Secrets come in as plaintext and are
 *  encrypted before persistence; pass `null` to clear, `undefined` to leave. */
export interface SettingsPatch {
  kvm?: Partial<KvmSettings>
  model?: string
  vaultPath?: string | null
  caps?: Partial<Caps>
  defaultApprovalMode?: ApprovalMode
  updateRepo?: string | null
  anthropicApiKeyPlaintext?: string | null
  autoExportSummary?: boolean
  summaryExportDir?: string | null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean
  message: string
}

export interface SettingsValidation {
  kvm: ValidationResult
  apiKey: ValidationResult
  vault: ValidationResult
}

// ---------------------------------------------------------------------------
// Orchestrator / session
// ---------------------------------------------------------------------------

export type OrchestratorState =
  | 'IDLE'
  | 'OBSERVING'
  | 'PLANNING'
  | 'EXECUTING_STEP'
  | 'VERIFYING'
  | 'FIXED'
  | 'NEXT_STEP'
  | 'NEEDS_HUMAN'
  | 'GAVE_UP'

export type SessionRunState = 'idle' | 'running' | 'paused' | 'stopped' | 'finished'

export type AttemptOutcome =
  | 'fixed'
  | 'no_change'
  | 'new_failure'
  | 'in_progress'
  | 'error'
  | 'skipped'

export interface Attempt {
  id: string
  stepId: string
  stepName: string
  actions: string[]
  outcome: AttemptOutcome
  startedAt: number
  endedAt: number | null
  detail?: string
}

export type NarrationKind =
  | 'observe'
  | 'plan'
  | 'action'
  | 'verify'
  | 'info'
  | 'warn'
  | 'error'
  | 'chat'

export interface NarrationEntry {
  id: string
  ts: number
  kind: NarrationKind
  text: string
}

export interface ChatMessage {
  id: string
  ts: number
  role: 'admin' | 'agent'
  text: string
}

export interface CostInfo {
  inputTokens: number
  outputTokens: number
  usd: number
}

// ---------------------------------------------------------------------------
// Actions & approval
// ---------------------------------------------------------------------------

export type ProposedActionKind =
  | 'kvm_key'
  | 'kvm_type'
  | 'kvm_click'
  | 'kvm_move'
  | 'kvm_scroll'
  | 'kvm_mount_iso'
  | 'kvm_reboot'
  | 'local_powershell'
  | 'local_screenshot'
  | 'wait'
  | 'note'

export interface ProposedAction {
  id: string
  kind: ProposedActionKind
  /** One-line human-readable summary shown in the approval card. */
  summary: string
  /** Full detail: the exact command, coordinates, or key sequence. */
  detail: string
  /** Structured payload the backend executes. */
  payload: unknown
  requiresApproval: boolean
  /** Set when the hard blocklist forced approval even in auto mode. */
  blocklistReason?: string
}

export interface ApprovalRequest {
  action: ProposedAction
  autoApproveStepAvailable: boolean
}

export type ApprovalDecision =
  | { type: 'approve'; autoApproveStep?: boolean }
  | { type: 'deny'; reason?: string }

// ---------------------------------------------------------------------------
// Session snapshot (persisted + streamed to the renderer)
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  id: string
  mode: TargetMode
  machineDescriptor: string
  problemDescription: string
  approvalMode: ApprovalMode
  runState: SessionRunState
  orchestratorState: OrchestratorState
  playbookId: string
  currentStepId: string | null
  currentStepName: string | null
  attempts: Attempt[]
  narration: NarrationEntry[]
  chat: ChatMessage[]
  cost: CostInfo
  startedAt: number
  updatedAt: number
  endedAt: number | null
  manualControl: boolean
  pendingApproval: ApprovalRequest | null
  failedStepIds: string[]
  iterations: number
  lastError: string | null
}

export interface StartSessionInput {
  mode: TargetMode
  machineDescriptor: string
  problemDescription: string
  approvalMode: ApprovalMode
  playbookId?: string
}

// ---------------------------------------------------------------------------
// Boot watcher
// ---------------------------------------------------------------------------

export type BootOutcome = 'FIXED' | 'SAME_FAILURE' | 'NEW_FAILURE' | 'UNKNOWN'

export type FailureClass =
  | 'bios'
  | 'vendor_logo_hang'
  | 'bsod'
  | 'boot_device_not_found'
  | 'winre'
  | 'spinning_loop'
  | 'black_screen'
  | 'desktop'
  | 'login'
  | 'bitlocker_recovery'
  | 'unknown'

export interface Observation {
  failureClass: FailureClass
  stopCode: string | null
  summary: string
  confident: boolean
}

// ---------------------------------------------------------------------------
// Local backend
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  elevated: boolean
  truncated: boolean
}

export interface ElevationStatus {
  supported: boolean
  elevated: boolean
  platform: string
}

// ---------------------------------------------------------------------------
// Frame capture (renderer → main)
// ---------------------------------------------------------------------------

export interface CapturedFrame {
  /** Downscaled JPEG, base64 (no data: prefix). */
  jpegBase64: string
  /** Dimensions of the downscaled image sent to the model. */
  width: number
  height: number
  /** Native frame dimensions before downscale. */
  nativeWidth: number
  nativeHeight: number
}

// ---------------------------------------------------------------------------
// Logging & updates
// ---------------------------------------------------------------------------

export interface LogEvent {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'none'
  | 'error'
  | 'deferred'

export interface UpdateStatus {
  state: UpdateState
  version?: string
  percent?: number
  message?: string
}

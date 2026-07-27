import type { ProposedActionKind, TargetMode } from '@shared/types'

export interface ToolInvocation {
  /** tool_use id from the model. */
  id: string
  name: string
  input: Record<string, unknown>
}

export interface RenderedAction {
  kind: ProposedActionKind
  summary: string
  detail: string
}

export interface ToolExecResult {
  /** Text returned to the model as the tool_result content. */
  resultText: string
  /** Optional image returned to the model (base64, no data: prefix). */
  imageBase64?: string
  imageMediaType?: string
  isError?: boolean
  /** Human-readable lines appended to the attempt log and narration. */
  actionLog: string[]
}

export interface PerceiveResult {
  text: string
  imageBase64?: string
  imageMediaType?: string
}

/**
 * The single seam between the orchestrator and a target. The orchestrator,
 * approval flow, attempt history, chat, and vault learning are identical in both
 * modes; only perception (perceive/watchFrame) and action (tools/renderAction/
 * execute) differ.
 */
export interface TargetBackend {
  readonly mode: TargetMode
  /** Whether a reboot + boot-watch cycle is meaningful (KVM: yes, Local: no). */
  readonly supportsReboot: boolean

  connect(): Promise<void>
  dispose(): Promise<void>

  /** Anthropic tool definitions available to the model in this mode. */
  tools(): Record<string, unknown>[]
  /** Beta headers this backend needs (computer-use for KVM). */
  betas(): string[]
  /** Extra system-prompt guidance specific to this backend. */
  systemHint(): string

  /** Perceive current state to seed a step (KVM: a screenshot; Local: text). */
  perceive(): Promise<PerceiveResult>

  /** Map a tool invocation to a proposed action (for approval + blocklist). */
  renderAction(inv: ToolInvocation): RenderedAction
  /** Execute a tool invocation and return a tool_result payload. */
  execute(inv: ToolInvocation): Promise<ToolExecResult>

  /** Reboot the target (KVM only; no-op where unsupported). */
  reboot(): Promise<void>
  /** A fresh perception frame for the boot watcher. */
  watchFrame(): Promise<PerceiveResult>
}

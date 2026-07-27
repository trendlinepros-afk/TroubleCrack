import type { TargetMode } from '../types'

export interface PlaybookStep {
  id: string
  name: string
  /** Natural-language goal that seeds the per-step Claude session. */
  goal: string
  /** Concrete guidance (commands / key hints) the model may draw on. */
  hints?: string[]
  /** This step needs a command line first (WinRE, or ISO + Shift+F10). */
  requiresCommandLine?: boolean
  /** Reboot + run the boot watcher after this step completes. */
  rebootAfter?: boolean
  /** Step is inherently high-risk: always require approval regardless of mode. */
  alwaysApprove?: boolean
  /** Terminal step: writing the report / recommending reimage. */
  terminal?: boolean
}

export interface Playbook {
  id: string
  title: string
  mode: TargetMode
  /** Symptom tags used for vault lesson matching. */
  tags: string[]
  steps: PlaybookStep[]
}

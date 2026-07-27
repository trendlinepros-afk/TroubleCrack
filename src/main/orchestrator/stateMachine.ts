import type { BootOutcome, Caps, OrchestratorState } from '@shared/types'

/**
 * Pure orchestrator state machine. No Electron, no Anthropic, no I/O — so it can
 * be unit-tested exhaustively. The RepairSession drives it: it reduces on an
 * event to get the next context, performs the side effect the new state implies,
 * then reduces again with the result.
 *
 *   IDLE → OBSERVING → PLANNING → EXECUTING_STEP → VERIFYING →
 *     (FIXED | NEXT_STEP → OBSERVING | NEEDS_HUMAN | GAVE_UP)
 */

export interface OrchestratorContext {
  state: OrchestratorState
  stepIndex: number
  totalSteps: number
  /** Step ids that have been marked failed this session (never retried). */
  failedStepIds: string[]
  iterations: number
  spentUsd: number
  elapsedMs: number
  caps: Caps
  /** Set when a cap forced NEEDS_HUMAN, for reporting. */
  capHit: 'iterations' | 'spend' | 'wallclock' | null
}

export type VerifyOutcome = BootOutcome | 'NO_CHANGE'

export type OrchestratorEvent =
  | { type: 'START' }
  | { type: 'OBSERVE_DONE' }
  | { type: 'PLAN_DONE' }
  | { type: 'EXECUTE_DONE' }
  | { type: 'VERIFY_DONE'; outcome: VerifyOutcome; failedStepId?: string }
  | { type: 'NEEDS_HUMAN' }

export function initialContext(totalSteps: number, caps: Caps): OrchestratorContext {
  return {
    state: 'IDLE',
    stepIndex: 0,
    totalSteps,
    failedStepIds: [],
    iterations: 0,
    spentUsd: 0,
    elapsedMs: 0,
    caps,
    capHit: null
  }
}

export function isTerminalState(s: OrchestratorState): boolean {
  return s === 'FIXED' || s === 'GAVE_UP' || s === 'NEEDS_HUMAN'
}

/** Which cap (if any) has been exceeded. */
export function checkCaps(ctx: OrchestratorContext): {
  hit: boolean
  which?: 'iterations' | 'spend' | 'wallclock'
} {
  if (ctx.iterations >= ctx.caps.maxIterations) return { hit: true, which: 'iterations' }
  if (ctx.spentUsd >= ctx.caps.maxSpendUsd) return { hit: true, which: 'spend' }
  if (ctx.elapsedMs >= ctx.caps.maxWallClockMs) return { hit: true, which: 'wallclock' }
  return { hit: false }
}

function hasMoreSteps(ctx: OrchestratorContext): boolean {
  return ctx.stepIndex + 1 < ctx.totalSteps
}

/**
 * The core transition. Returns a NEW context (never mutates). Cap checks are
 * applied whenever we are about to spend another iteration (entering
 * EXECUTING_STEP) so a runaway session lands in NEEDS_HUMAN, never a crash.
 */
export function reduce(ctx: OrchestratorContext, ev: OrchestratorEvent): OrchestratorContext {
  // A NEEDS_HUMAN event always wins from any non-terminal state.
  if (ev.type === 'NEEDS_HUMAN' && !isTerminalState(ctx.state)) {
    return { ...ctx, state: 'NEEDS_HUMAN' }
  }
  if (isTerminalState(ctx.state)) return ctx

  switch (ctx.state) {
    case 'IDLE':
      if (ev.type === 'START') return { ...ctx, state: 'OBSERVING' }
      return ctx

    case 'OBSERVING':
      if (ev.type === 'OBSERVE_DONE') return { ...ctx, state: 'PLANNING' }
      return ctx

    case 'PLANNING':
      if (ev.type === 'PLAN_DONE') {
        const cap = checkCaps(ctx)
        if (cap.hit) return { ...ctx, state: 'NEEDS_HUMAN', capHit: cap.which ?? null }
        return { ...ctx, state: 'EXECUTING_STEP', iterations: ctx.iterations + 1 }
      }
      return ctx

    case 'EXECUTING_STEP':
      if (ev.type === 'EXECUTE_DONE') return { ...ctx, state: 'VERIFYING' }
      return ctx

    case 'VERIFYING':
      if (ev.type === 'VERIFY_DONE') {
        const failedStepIds = ev.failedStepId
          ? Array.from(new Set([...ctx.failedStepIds, ev.failedStepId]))
          : ctx.failedStepIds
        if (ev.outcome === 'FIXED') {
          return { ...ctx, state: 'FIXED', failedStepIds }
        }
        // SAME_FAILURE / NEW_FAILURE / NO_CHANGE / UNKNOWN → advance if possible.
        if (hasMoreSteps(ctx)) {
          return { ...ctx, state: 'NEXT_STEP', failedStepIds }
        }
        return { ...ctx, state: 'GAVE_UP', failedStepIds }
      }
      return ctx

    case 'NEXT_STEP':
      // Transient: the session advances the step and re-observes.
      if (ev.type === 'OBSERVE_DONE' || ev.type === 'START') {
        return { ...ctx, state: 'OBSERVING', stepIndex: ctx.stepIndex + 1 }
      }
      return ctx

    default:
      return ctx
  }
}

/** Convenience for the session: after NEXT_STEP, move to the next step's OBSERVING. */
export function advanceToNextStep(ctx: OrchestratorContext): OrchestratorContext {
  return reduce({ ...ctx, state: 'NEXT_STEP' }, { type: 'START' })
}

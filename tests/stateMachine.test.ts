import { describe, it, expect } from 'vitest'
import {
  advanceToNextStep,
  checkCaps,
  initialContext,
  isTerminalState,
  reduce,
  type OrchestratorContext
} from '../src/main/orchestrator/stateMachine'
import type { Caps } from '../src/shared/types'

const caps: Caps = { maxIterations: 3, maxSpendUsd: 10, maxWallClockMs: 60_000 }

function run(ctx: OrchestratorContext, events: Parameters<typeof reduce>[1][]): OrchestratorContext {
  return events.reduce((c, e) => reduce(c, e), ctx)
}

describe('orchestrator state machine', () => {
  it('starts IDLE and moves to OBSERVING on START', () => {
    const ctx = initialContext(9, caps)
    expect(ctx.state).toBe('IDLE')
    expect(reduce(ctx, { type: 'START' }).state).toBe('OBSERVING')
  })

  it('walks OBSERVING → PLANNING → EXECUTING_STEP → VERIFYING', () => {
    let ctx = initialContext(9, caps)
    ctx = reduce(ctx, { type: 'START' })
    ctx = reduce(ctx, { type: 'OBSERVE_DONE' })
    expect(ctx.state).toBe('PLANNING')
    ctx = reduce(ctx, { type: 'PLAN_DONE' })
    expect(ctx.state).toBe('EXECUTING_STEP')
    expect(ctx.iterations).toBe(1)
    ctx = reduce(ctx, { type: 'EXECUTE_DONE' })
    expect(ctx.state).toBe('VERIFYING')
  })

  it('reaches FIXED (terminal) on a fixed verify', () => {
    let ctx = run(initialContext(9, caps), [
      { type: 'START' },
      { type: 'OBSERVE_DONE' },
      { type: 'PLAN_DONE' },
      { type: 'EXECUTE_DONE' }
    ])
    ctx = reduce(ctx, { type: 'VERIFY_DONE', outcome: 'FIXED' })
    expect(ctx.state).toBe('FIXED')
    expect(isTerminalState(ctx.state)).toBe(true)
  })

  it('advances to the next step on a non-fixed outcome when steps remain', () => {
    let ctx = run(initialContext(3, caps), [
      { type: 'START' },
      { type: 'OBSERVE_DONE' },
      { type: 'PLAN_DONE' },
      { type: 'EXECUTE_DONE' }
    ])
    ctx = reduce(ctx, { type: 'VERIFY_DONE', outcome: 'SAME_FAILURE', failedStepId: 'step-0' })
    expect(ctx.state).toBe('NEXT_STEP')
    expect(ctx.failedStepIds).toEqual(['step-0'])
    ctx = advanceToNextStep(ctx)
    expect(ctx.state).toBe('OBSERVING')
    expect(ctx.stepIndex).toBe(1)
  })

  it('gives up when the last step does not fix it', () => {
    // Single-step playbook: no more steps after failure.
    let ctx = run(initialContext(1, caps), [
      { type: 'START' },
      { type: 'OBSERVE_DONE' },
      { type: 'PLAN_DONE' },
      { type: 'EXECUTE_DONE' }
    ])
    ctx = reduce(ctx, { type: 'VERIFY_DONE', outcome: 'NEW_FAILURE', failedStepId: 's0' })
    expect(ctx.state).toBe('GAVE_UP')
    expect(isTerminalState(ctx.state)).toBe(true)
  })

  it('lands in NEEDS_HUMAN when the iteration cap is hit at PLANNING', () => {
    const tightCaps: Caps = { ...caps, maxIterations: 1 }
    let ctx = initialContext(9, tightCaps)
    ctx = reduce(ctx, { type: 'START' })
    ctx = reduce(ctx, { type: 'OBSERVE_DONE' })
    ctx = reduce(ctx, { type: 'PLAN_DONE' }) // iteration 1
    ctx = reduce(ctx, { type: 'EXECUTE_DONE' })
    ctx = reduce(ctx, { type: 'VERIFY_DONE', outcome: 'NO_CHANGE', failedStepId: 's0' })
    ctx = advanceToNextStep(ctx) // OBSERVING step 2
    ctx = reduce(ctx, { type: 'OBSERVE_DONE' })
    ctx = reduce(ctx, { type: 'PLAN_DONE' }) // cap hit (already at 1 iteration)
    expect(ctx.state).toBe('NEEDS_HUMAN')
    expect(ctx.capHit).toBe('iterations')
  })

  it('honors a spend cap', () => {
    const ctx: OrchestratorContext = { ...initialContext(9, caps), spentUsd: 20 }
    expect(checkCaps(ctx)).toEqual({ hit: true, which: 'spend' })
  })

  it('honors a wall-clock cap', () => {
    const ctx: OrchestratorContext = { ...initialContext(9, caps), elapsedMs: 120_000 }
    expect(checkCaps(ctx)).toEqual({ hit: true, which: 'wallclock' })
  })

  it('NEEDS_HUMAN event overrides any non-terminal state', () => {
    let ctx = reduce(initialContext(9, caps), { type: 'START' })
    ctx = reduce(ctx, { type: 'NEEDS_HUMAN' })
    expect(ctx.state).toBe('NEEDS_HUMAN')
  })

  it('never leaves a terminal state', () => {
    const fixed = { ...initialContext(9, caps), state: 'FIXED' as const }
    expect(reduce(fixed, { type: 'START' }).state).toBe('FIXED')
    expect(reduce(fixed, { type: 'NEEDS_HUMAN' }).state).toBe('FIXED')
  })

  it('does not record duplicate failed step ids', () => {
    let ctx = run(initialContext(5, caps), [
      { type: 'START' },
      { type: 'OBSERVE_DONE' },
      { type: 'PLAN_DONE' },
      { type: 'EXECUTE_DONE' }
    ])
    ctx = reduce(ctx, { type: 'VERIFY_DONE', outcome: 'SAME_FAILURE', failedStepId: 'dup' })
    ctx = advanceToNextStep(ctx)
    ctx = run(ctx, [{ type: 'OBSERVE_DONE' }, { type: 'PLAN_DONE' }, { type: 'EXECUTE_DONE' }])
    ctx = reduce(ctx, { type: 'VERIFY_DONE', outcome: 'SAME_FAILURE', failedStepId: 'dup' })
    expect(ctx.failedStepIds).toEqual(['dup'])
  })
})

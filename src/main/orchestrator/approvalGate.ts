import type { ApprovalDecision, ProposedAction } from '@shared/types'

/**
 * Holds pending approval promises. The session decides *whether* an action needs
 * approval (mode + per-step auto-approve + blocklist); this gate only parks the
 * promise until the admin submits a decision, or the session cancels.
 */
export class ApprovalGate {
  private pending = new Map<string, (d: ApprovalDecision) => void>()

  wait(action: ProposedAction): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(action.id, resolve)
    })
  }

  submit(actionId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(actionId)
    if (!resolve) return false
    this.pending.delete(actionId)
    resolve(decision)
    return true
  }

  has(actionId: string): boolean {
    return this.pending.has(actionId)
  }

  cancelAll(reason = 'Session stopped'): void {
    for (const [, resolve] of this.pending) resolve({ type: 'deny', reason })
    this.pending.clear()
  }
}

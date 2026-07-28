import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { fmtTime, scrollAnchor } from '../util'
import type { ApprovalRequest } from '@shared/types'

/** The AI's running narration + pending approval requests. */
export function NowPanel(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const narration = snapshot?.narration ?? []

  useEffect(() => {
    scrollAnchor(bottomRef.current)
  }, [narration.length])

  return (
    <div className="panel" style={{ flex: 2 }}>
      <div className="panel-head">
        Now
        {snapshot?.currentStepName && <span className="pill">{snapshot.currentStepName}</span>}
        {snapshot && <span className="pill">{snapshot.orchestratorState}</span>}
      </div>
      <div className="panel-body">
        {snapshot?.pendingApproval && <ApprovalCard req={snapshot.pendingApproval} />}
        {narration.length === 0 && <div className="muted">No activity yet. Start a session below.</div>}
        {narration.map((n) => (
          <div key={n.id} className={`feed-item ${n.kind}`}>
            <span className="ts">{fmtTime(n.ts)}</span>
            <span className="k">{n.kind}</span>
            <span className="txt">{n.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function ApprovalCard({ req }: { req: ApprovalRequest }): React.JSX.Element {
  const { action } = req
  const approve = (autoApproveStep: boolean): void => {
    void window.api.submitApproval(action.id, { type: 'approve', autoApproveStep })
  }
  const deny = (): void => {
    void window.api.submitApproval(action.id, { type: 'deny', reason: 'Denied by administrator' })
  }
  return (
    <div className={`approval ${action.blocklistReason ? 'blocked' : ''}`}>
      <div className="summary">Approve action?</div>
      <div>{action.summary}</div>
      <div className="detail">{action.detail}</div>
      {action.blocklistReason && <div className="flag">⚠ {action.blocklistReason} — approval required.</div>}
      <div className="actions">
        <button className="primary" onClick={() => approve(false)}>
          Approve
        </button>
        {req.autoApproveStepAvailable && (
          <button className="ok" onClick={() => approve(true)}>
            Approve + auto-approve this step
          </button>
        )}
        <button className="danger" onClick={deny}>
          Deny
        </button>
      </div>
    </div>
  )
}

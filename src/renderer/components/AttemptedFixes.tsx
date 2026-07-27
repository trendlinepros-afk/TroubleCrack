import { useStore } from '../state/store'
import { fmtDuration, outcomeIcon } from '../util'

/** The session's attempt history: step, actions, outcome, duration. */
export function AttemptedFixes(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const attempts = snapshot?.attempts ?? []

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">Attempted fixes</div>
      <div className="panel-body">
        {attempts.length === 0 && <div className="muted">No attempts yet.</div>}
        {attempts.map((a) => {
          const dur = a.endedAt ? a.endedAt - a.startedAt : Date.now() - a.startedAt
          return (
            <div key={a.id} className="attempt" title={a.actions.join('\n')}>
              <span className="outcome">{outcomeIcon(a.outcome)}</span>
              <div style={{ flex: 1 }}>
                <div>{a.stepName}</div>
                <div className="meta">
                  {a.outcome} · {fmtDuration(dur)} · {a.actions.length} action{a.actions.length === 1 ? '' : 's'}
                  {a.detail ? ` · ${a.detail}` : ''}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

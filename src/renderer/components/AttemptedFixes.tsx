import { useState } from 'react'
import { useStore } from '../state/store'
import { fmtDuration, outcomeIcon } from '../util'

/** The session's attempt history: step, actions, outcome, duration — plus
 *  one-click export/copy of a Markdown summary of the steps taken. */
export function AttemptedFixes(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const attempts = snapshot?.attempts ?? []
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const canExport = snapshot !== null && !busy

  const flash = (msg: string): void => {
    setNote(msg)
    setTimeout(() => setNote(''), 3000)
  }

  const doExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.exportSummary()
      if (r.ok) flash('Saved ✓')
      else if (!r.canceled) flash(r.error ?? 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const doCopy = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.copySummary()
      flash(r.ok ? 'Copied ✓' : r.error ?? 'Copy failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span>Attempted fixes</span>
        <span className="spacer" />
        {note && <span className="pill ok">{note}</span>}
        <button
          className="mini"
          disabled={!canExport}
          onClick={() => void doCopy()}
          title="Copy a Markdown summary of the steps taken to the clipboard"
        >
          Copy
        </button>
        <button
          className="mini"
          disabled={!canExport}
          onClick={() => void doExport()}
          title="Save a Markdown summary of the steps taken to a file"
        >
          ⤓ Export…
        </button>
      </div>
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

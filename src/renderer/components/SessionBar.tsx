import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { fmtDuration, fmtUsd } from '../util'
import type { ApprovalMode, TargetMode } from '@shared/types'

/** Target selector, problem input, Start/Pause/Stop, mode toggle, elapsed, cost. */
export function SessionBar(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const settings = useStore((s) => s.settings)
  const [mode, setMode] = useState<TargetMode>('kvm')
  const [machine, setMachine] = useState('')
  const [problem, setProblem] = useState('')
  const [, forceTick] = useState(0)

  const active = snapshot?.runState === 'running' || snapshot?.runState === 'paused'
  const running = snapshot?.runState === 'running'
  const approvalMode: ApprovalMode = snapshot?.approvalMode ?? settings?.defaultApprovalMode ?? 'approval'

  // Tick once a second so elapsed time updates live.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  const start = async (): Promise<void> => {
    await window.api.startSession({
      mode,
      machineDescriptor: machine || (mode === 'local' ? 'This computer' : 'KVM target'),
      problemDescription: problem,
      approvalMode
    })
  }

  const toggleMode = async (): Promise<void> => {
    const next: ApprovalMode = approvalMode === 'approval' ? 'auto' : 'approval'
    if (active) await window.api.setApprovalMode(next)
  }

  const elapsedMs = snapshot ? (snapshot.endedAt ?? Date.now()) - snapshot.startedAt : 0

  return (
    <div className="sessionbar">
      <div className="field">
        <label>Target</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as TargetMode)} disabled={active}>
          <option value="kvm">JetKVM device{settings?.kvm.address ? ` (${settings.kvm.address})` : ''}</option>
          <option value="local">This computer</option>
        </select>
      </div>
      <div className="field">
        <label>Machine</label>
        <input
          value={active ? snapshot?.machineDescriptor ?? '' : machine}
          placeholder={mode === 'local' ? 'This computer' : 'e.g. Dell OptiPlex 7080'}
          onChange={(e) => setMachine(e.target.value)}
          disabled={active}
        />
      </div>
      <div className="field grow">
        <label>Problem</label>
        <input
          value={active ? snapshot?.problemDescription ?? '' : problem}
          placeholder="Describe the problem (e.g. won't boot, BSOD 0x7B, VPN won't connect)"
          onChange={(e) => setProblem(e.target.value)}
          disabled={active}
        />
      </div>

      <div className="controls">
        {!active && (
          <button className="primary" onClick={() => void start()} disabled={!settings?.hasApiKey}>
            ▶ Start
          </button>
        )}
        {active && running && (
          <button onClick={() => void window.api.pauseSession()}>⏸ Pause</button>
        )}
        {active && !running && snapshot?.runState === 'paused' && (
          <button className="primary" onClick={() => void window.api.resumeSession()}>
            ▶ Resume
          </button>
        )}
        {active && (
          <button className="danger" onClick={() => void window.api.stopSession()}>
            ⏹ Stop
          </button>
        )}
        <button onClick={() => void toggleMode()} disabled={!active} title="Approval / Auto mode">
          {approvalMode === 'approval' ? '🛡 Approval' : '⚡ Auto'}
        </button>
        <span className="metric">⏱ {fmtDuration(elapsedMs)}</span>
        <span className="metric">{fmtUsd(snapshot?.cost.usd ?? 0)}</span>
      </div>
    </div>
  )
}

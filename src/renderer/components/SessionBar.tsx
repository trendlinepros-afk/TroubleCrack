import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { fmtDuration, fmtUsd } from '../util'
import type { ApprovalMode, TargetMode } from '@shared/types'

/** Target selector, problem input, Start/Pause/Stop, mode toggle, elapsed, cost. */
export function SessionBar(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const settings = useStore((s) => s.settings)
  const setView = useStore((s) => s.setView)
  const focusProblemNonce = useStore((s) => s.focusProblemNonce)
  const [mode, setMode] = useState<TargetMode>('kvm')
  const [machine, setMachine] = useState('')
  const [problem, setProblem] = useState('')
  const [, forceTick] = useState(0)
  const problemRef = useRef<HTMLInputElement | null>(null)

  const active = snapshot?.runState === 'running' || snapshot?.runState === 'paused'
  const running = snapshot?.runState === 'running'
  const approvalMode: ApprovalMode = snapshot?.approvalMode ?? settings?.defaultApprovalMode ?? 'approval'
  const hasApiKey = settings?.hasApiKey ?? false
  const kvmConfigured = Boolean(settings?.kvm.deviceId || settings?.kvm.deviceName || settings?.kvm.hostname)
  const needsDevice = mode === 'kvm' && !kvmConfigured && !active

  // Tick once a second so elapsed time updates live.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  // The "New Session" menu item / shortcut asks us to pull focus to the problem.
  useEffect(() => {
    if (focusProblemNonce > 0 && !active) problemRef.current?.focus()
  }, [focusProblemNonce, active])

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
  const canStart = hasApiKey && problem.trim().length > 0

  const startTitle = !hasApiKey
    ? 'Add an Anthropic API key in Settings first'
    : problem.trim().length === 0
      ? 'Describe the problem first'
      : 'Start the repair session'

  return (
    <>
      <div className="sessionbar">
        <div className="field">
          <label>Target</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as TargetMode)} disabled={active}>
            <option value="kvm">JetKVM device{settings?.kvm.deviceName ? ` (${settings.kvm.deviceName})` : ''}</option>
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
            ref={problemRef}
            value={active ? snapshot?.problemDescription ?? '' : problem}
            placeholder="Describe the problem (e.g. won't boot, BSOD 0x7B, VPN won't connect)"
            onChange={(e) => setProblem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canStart && !active) void start()
            }}
            disabled={active}
          />
        </div>

        <div className="controls">
          {!active && (
            <button className="primary" onClick={() => void start()} disabled={!canStart} title={startTitle}>
              ▶ Start
            </button>
          )}
          {active && running && (
            <button onClick={() => void window.api.pauseSession()} title="Pause the agent">
              ⏸ Pause
            </button>
          )}
          {active && !running && snapshot?.runState === 'paused' && (
            <button className="primary" onClick={() => void window.api.resumeSession()} title="Resume the agent">
              ▶ Resume
            </button>
          )}
          {active && (
            <button className="danger" onClick={() => void window.api.stopSession()} title="Stop the session">
              ⏹ Stop
            </button>
          )}
          <button
            onClick={() => void toggleMode()}
            disabled={!active}
            title={
              approvalMode === 'approval'
                ? 'Approval mode: every action waits for you. Click to switch to Auto.'
                : 'Auto mode: only risky actions ask. Click to switch to Approval.'
            }
          >
            {approvalMode === 'approval' ? '🛡 Approval' : '⚡ Auto'}
          </button>
          <span className="metric" title="Elapsed time">
            ⏱ {fmtDuration(elapsedMs)}
          </span>
          <span className="metric" title="Estimated API cost this session">
            {fmtUsd(snapshot?.cost.usd ?? 0)}
          </span>
        </div>
      </div>
      {needsDevice && (
        <div className="sessionbar-hint">
          No JetKVM selected yet.{' '}
          <button className="linklike" onClick={() => setView('settings')}>
            Discover a device in Settings
          </button>{' '}
          — or start anyway and it'll try the last-known device.
        </div>
      )}
    </>
  )
}

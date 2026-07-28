import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { scrollAnchor } from '../util'
import { kvmClient } from '../kvm/singleton'
import { ConnectionBadge } from './ConnectionBadge'

/**
 * Live Preview. In KVM mode this is the WebRTC video stream with a click-to-take-
 * over toggle. In Local mode it becomes a live command transcript (each command
 * and its output as it runs).
 */
export function LivePreview(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const connection = useStore((s) => s.connection)
  const snapshot = useStore((s) => s.snapshot)
  const [manual, setManual] = useState(false)

  const mode = snapshot?.mode ?? 'kvm'
  const connected = connection.phase === 'connected'

  useEffect(() => {
    kvmClient.setVideoElement(videoRef.current)
    return () => kvmClient.setVideoElement(null)
  }, [])

  const toggleManual = (): void => {
    const next = !manual
    setManual(next)
    void window.api.setManualControl(next)
  }

  if (mode === 'local') {
    return <LocalTranscript />
  }

  return (
    <div className={`preview ${manual ? 'manual' : ''}`}>
      <ConnectionBadge status={connection} />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} autoPlay playsInline muted />
      {connection.phase !== 'connected' && (
        <div className="placeholder">
          <p>No video.</p>
          <p className="muted">{connection.detail}</p>
        </div>
      )}
      <div className="preview-toolbar">
        <button
          className={manual ? 'ok' : ''}
          onClick={toggleManual}
          disabled={!connected}
          title={
            !connected
              ? 'Connect to the device first'
              : manual
                ? 'Return control to the agent'
                : 'Drive the target yourself; the agent pauses while you do'
          }
        >
          {manual ? '🖐 Manual control ON' : 'Take over (manual)'}
        </button>
      </div>
      {manual && (
        <div className="badge manual-note" style={{ top: 'auto', bottom: 10, left: 10 }}>
          Your input goes to the target. The agent is paused.
        </div>
      )}
    </div>
  )
}

/** Local-mode transcript: shows the agent's command actions as they run. */
function LocalTranscript(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const lines = snapshot
    ? snapshot.attempts.flatMap((a) =>
        a.actions.map((line) => ({ step: a.stepName, line }))
      )
    : []

  useEffect(() => {
    scrollAnchor(bottomRef.current)
  }, [lines.length])

  return (
    <div className="transcript">
      {lines.length === 0 && (
        <div className="muted">
          Command transcript will appear here as the agent runs PowerShell on this machine.
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} className="out">
          <span className="cmd">▸</span> {l.line}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

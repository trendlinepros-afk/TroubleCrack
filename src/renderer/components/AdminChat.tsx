import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { fmtTime } from '../util'

/**
 * Free-text chat with the agent. During a session, messages are injected as
 * high-priority guidance. With no session running, describing a problem makes
 * the agent offer to start a Local-mode session from that message.
 */
export function AdminChat(): React.JSX.Element {
  const snapshot = useStore((s) => s.snapshot)
  const idleChat = useStore((s) => s.idleChat)
  const addIdleChat = useStore((s) => s.addIdleChat)
  const settings = useStore((s) => s.settings)
  const [text, setText] = useState('')
  const [offerFor, setOfferFor] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const active = snapshot?.runState === 'running' || snapshot?.runState === 'paused'
  const messages = active ? snapshot?.chat ?? [] : idleChat

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t) return
    setText('')
    if (active) {
      await window.api.sendChat(t)
      return
    }
    addIdleChat({ id: `${Date.now()}-a`, ts: Date.now(), role: 'admin', text: t })
    const res = await window.api.idleChat(t)
    if (res.reply) {
      addIdleChat({ id: `${Date.now()}-r`, ts: Date.now(), role: 'agent', text: res.reply })
    }
    if (res.suggestLocalSession) setOfferFor(t)
  }

  const startLocal = async (problem: string): Promise<void> => {
    setOfferFor(null)
    await window.api.startSession({
      mode: 'local',
      machineDescriptor: 'This computer',
      problemDescription: problem,
      approvalMode: settings?.defaultApprovalMode ?? 'approval'
    })
  }

  return (
    <div className="panel chat" style={{ flex: 1 }}>
      <div className="panel-head">Admin chat</div>
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="muted">
            {active
              ? 'Send guidance to the agent — e.g. "try disabling the NVIDIA driver".'
              : 'Describe a problem with this computer and I can start a Local session.'}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div>{m.text}</div>
            <div className="meta muted" style={{ fontSize: 10 }}>
              {fmtTime(m.ts)}
            </div>
          </div>
        ))}
        {!active && offerFor && (
          <button className="primary" onClick={() => void startLocal(offerFor)}>
            ▶ Start a Local session for this
          </button>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input">
        <textarea
          rows={2}
          value={text}
          placeholder={active ? 'Guidance for the agent…' : 'Describe the problem…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button className="primary" onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  )
}

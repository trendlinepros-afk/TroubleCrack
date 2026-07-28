import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './state/store'
import { lsGet, lsSet } from './util'
import { SessionBar } from './components/SessionBar'
import { LivePreview } from './components/LivePreview'
import { NowPanel } from './components/NowPanel'
import { AttemptedFixes } from './components/AttemptedFixes'
import { AdminChat } from './components/AdminChat'
import { SettingsPage } from './components/SettingsPage'

const PANEL_KEY = 'tc.rightWidth'

export function App(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const requestNewSession = useStore((s) => s.requestNewSession)
  const update = useStore((s) => s.update)
  const appVersion = useStore((s) => s.appVersion)
  const settings = useStore((s) => s.settings)
  const snapshot = useStore((s) => s.snapshot)
  const [rightWidth, setRightWidth] = useState(() => lsGet<number>(PANEL_KEY, 440))
  const dragging = useRef(false)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    document.body.classList.add('col-resizing')
    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      const fromRight = window.innerWidth - ev.clientX
      setRightWidth(Math.min(820, Math.max(320, fromRight)))
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.classList.remove('col-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Remember the panel width across launches (debounced by React's render).
  useEffect(() => {
    lsSet(PANEL_KEY, rightWidth)
  }, [rightWidth])

  // Native menu → renderer actions (Settings / New Session).
  useEffect(() => {
    return window.api.onMenuAction((action) => {
      if (action === 'open-settings') setView('settings')
      else if (action === 'new-session') requestNewSession()
    })
  }, [setView, requestNewSession])

  // Esc leaves Settings; it's the expected "back" gesture on a modal-ish page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && view === 'settings') setView('main')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, setView])

  const [showUpdateBanner, setShowUpdateBanner] = useState(true)
  const active = snapshot?.runState === 'running' || snapshot?.runState === 'paused'
  const needsApiKey = settings !== null && !settings.hasApiKey

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">TroubleCrack</span>
        <span className="muted">v{appVersion}</span>
        <span className="spacer" />
        {update.state === 'downloading' && (
          <span className="pill warn">Downloading update… {update.percent ?? 0}%</span>
        )}
        {update.state === 'deferred' && <span className="pill warn">Update ready (after session)</span>}
        <button
          className={view === 'settings' ? 'active' : ''}
          title={view === 'settings' ? 'Back to session (Esc)' : 'Settings (Ctrl+,)'}
          onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
        >
          {view === 'settings' ? '← Back' : '⚙ Settings'}
        </button>
      </div>

      {update.state === 'downloaded' && showUpdateBanner && (
        <div className="update-banner">
          <span>Update {update.version} downloaded. Restart now to install?</span>
          <button className="primary" onClick={() => void window.api.quitAndInstall()}>
            Restart now
          </button>
          <button onClick={() => setShowUpdateBanner(false)}>Later</button>
        </div>
      )}

      {needsApiKey && view === 'main' && (
        <div className="onboard-banner">
          <span className="onboard-icon" aria-hidden="true">
            👋
          </span>
          <div className="onboard-text">
            <strong>Welcome to TroubleCrack.</strong> Add your Anthropic API key to start repairing
            machines — it's stored encrypted and persists across updates.
          </div>
          <button className="primary" onClick={() => setView('settings')}>
            Add API key
          </button>
        </div>
      )}

      {view === 'settings' ? (
        <SettingsPage />
      ) : (
        <>
          <SessionBar />
          <div className="workspace">
            <div className="left">
              <LivePreview />
            </div>
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panels"
              onMouseDown={onDragStart}
            />
            <div className="right" style={{ width: rightWidth }}>
              <NowPanel />
              <AttemptedFixes />
              <AdminChat />
            </div>
          </div>
        </>
      )}

      {view === 'main' && !active && !needsApiKey && !snapshot && (
        <div className="statusbar muted">Ready. Describe a problem above and press Start, or open Settings to pick a device.</div>
      )}
    </div>
  )
}

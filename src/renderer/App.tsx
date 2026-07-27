import { useCallback, useRef, useState } from 'react'
import { useStore } from './state/store'
import { SessionBar } from './components/SessionBar'
import { LivePreview } from './components/LivePreview'
import { NowPanel } from './components/NowPanel'
import { AttemptedFixes } from './components/AttemptedFixes'
import { AdminChat } from './components/AdminChat'
import { SettingsPage } from './components/SettingsPage'

export function App(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const update = useStore((s) => s.update)
  const appVersion = useStore((s) => s.appVersion)
  const [rightWidth, setRightWidth] = useState(440)
  const dragging = useRef(false)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      const fromRight = window.innerWidth - ev.clientX
      setRightWidth(Math.min(820, Math.max(320, fromRight)))
    }
    const onUp = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const [showBanner, setShowBanner] = useState(true)

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">TroubleCrack</span>
        <span className="muted">v{appVersion}</span>
        <span className="spacer" />
        {update.state === 'downloading' && <span className="pill warn">Downloading update… {update.percent ?? 0}%</span>}
        {update.state === 'deferred' && <span className="pill warn">Update ready (after session)</span>}
        <button onClick={() => setView(view === 'settings' ? 'main' : 'settings')}>
          {view === 'settings' ? '← Back' : '⚙ Settings'}
        </button>
      </div>

      {update.state === 'downloaded' && showBanner && (
        <div className="update-banner">
          <span>Update {update.version} downloaded. Restart now to install?</span>
          <button className="primary" onClick={() => void window.api.quitAndInstall()}>
            Restart now
          </button>
          <button onClick={() => setShowBanner(false)}>Later</button>
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
            <div className="splitter" onMouseDown={onDragStart} />
            <div className="right" style={{ width: rightWidth }}>
              <NowPanel />
              <AttemptedFixes />
              <AdminChat />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

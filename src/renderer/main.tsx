import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { useStore } from './state/store'
import { setupKvmBridge } from './kvm/singleton'
import './styles.css'

function bootstrap(): void {
  const store = useStore.getState()

  setupKvmBridge()

  window.api.onSessionUpdate((s) => store.setSnapshot(s))
  window.api.onLog((e) => store.pushLog(e))
  window.api.onUpdateStatus((u) => store.setUpdate(u))

  void window.api.getSettings().then((s) => store.setSettings(s))
  void window.api.getAppVersion().then((v) => store.setAppVersion(v))
  void window.api.getElevation().then((e) => store.setElevation(e))
  void window.api.getSnapshot().then((s) => {
    if (s) store.setSnapshot(s)
  })
}

bootstrap()

const rootEl = document.getElementById('root')
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

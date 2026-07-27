import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { KvmAuthMode, SettingsValidation } from '@shared/types'

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5']

export function SettingsPage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const elevation = useStore((s) => s.elevation)
  const update = useStore((s) => s.update)
  const appVersion = useStore((s) => s.appVersion)

  const [address, setAddress] = useState('')
  const [useTls, setUseTls] = useState(false)
  const [authMode, setAuthMode] = useState<KvmAuthMode>('auto')
  const [kvmPassword, setKvmPassword] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [model, setModel] = useState('claude-opus-5')
  const [maxIterations, setMaxIterations] = useState(40)
  const [maxSpend, setMaxSpend] = useState(5)
  const [maxWallMin, setMaxWallMin] = useState(45)
  const [updateRepo, setUpdateRepo] = useState('')

  const [validation, setValidation] = useState<SettingsValidation | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!settings) return
    setAddress(settings.kvm.address)
    setUseTls(settings.kvm.useTls)
    setAuthMode(settings.kvm.authMode)
    setVaultPath(settings.vaultPath)
    setModel(settings.model)
    setMaxIterations(settings.caps.maxIterations)
    setMaxSpend(settings.caps.maxSpendUsd)
    setMaxWallMin(Math.round(settings.caps.maxWallClockMs / 60000))
    setUpdateRepo(settings.updateRepo ?? '')
  }, [settings])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.saveSettings({
        kvm: { address, useTls, authMode, ...(kvmPassword ? { password: kvmPassword } : {}) },
        model,
        vaultPath,
        caps: { maxIterations, maxSpendUsd: maxSpend, maxWallClockMs: maxWallMin * 60000 },
        updateRepo: updateRepo.trim() || null,
        ...(apiKey ? { anthropicApiKeyPlaintext: apiKey } : {})
      })
      setSettings(next)
      setApiKey('')
      setKvmPassword('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setBusy(false)
    }
  }

  const validate = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.validateSettings({
        kvm: { address, useTls, authMode, password: kvmPassword },
        anthropicApiKeyPlaintext: apiKey || undefined,
        vaultPath
      })
      setValidation(result)
    } finally {
      setBusy(false)
    }
  }

  const pickVault = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setVaultPath(dir)
  }

  const relaunchAdmin = async (): Promise<void> => {
    await window.api.relaunchAsAdmin()
  }

  return (
    <div className="settings">
      <h2>Settings</h2>

      <div className="group">
        <h3>JetKVM</h3>
        <div className="row">
          <div>
            <label>Address (host or host:port)</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.50" />
          </div>
          <div>
            <label>Auth mode</label>
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as KvmAuthMode)}>
              <option value="auto">Auto-detect</option>
              <option value="password">Password</option>
              <option value="noPassword">No password</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div>
            <label>Password {settings?.hasApiKey ? '' : ''}</label>
            <input
              type="password"
              value={kvmPassword}
              onChange={(e) => setKvmPassword(e.target.value)}
              placeholder="(leave blank to keep current)"
            />
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={useTls}
                onChange={(e) => setUseTls(e.target.checked)}
                style={{ width: 'auto', marginRight: 6 }}
              />
              Use HTTPS/TLS
            </label>
          </div>
        </div>
        {validation && (
          <div className="validation">
            <span className={validation.kvm.ok ? 'ok' : 'bad'}>
              {validation.kvm.ok ? '✓' : '✗'} {validation.kvm.message}
            </span>
          </div>
        )}
      </div>

      <div className="group">
        <h3>Anthropic</h3>
        <div className="row">
          <div>
            <label>API key {settings?.hasApiKey ? '(stored — encrypted)' : '(not set)'}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.hasApiKey ? '•••••••• (leave blank to keep)' : 'sk-ant-…'}
            />
          </div>
          <div>
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        {validation && (
          <div className="validation">
            <span className={validation.apiKey.ok ? 'ok' : 'bad'}>
              {validation.apiKey.ok ? '✓' : '✗'} {validation.apiKey.message}
            </span>
          </div>
        )}
      </div>

      <div className="group">
        <h3>Obsidian vault (self-learning)</h3>
        <div className="row single">
          <div>
            <label>Vault folder</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={vaultPath ?? ''} readOnly placeholder="(none — self-learning disabled)" />
              <button onClick={() => void pickVault()}>Choose…</button>
              {vaultPath && <button onClick={() => setVaultPath(null)}>Clear</button>}
            </div>
          </div>
        </div>
        {validation && (
          <div className="validation">
            <span className={validation.vault.ok ? 'ok' : 'bad'}>
              {validation.vault.ok ? '✓' : '✗'} {validation.vault.message}
            </span>
          </div>
        )}
      </div>

      <div className="group">
        <h3>Safety caps (per session)</h3>
        <div className="row">
          <div>
            <label>Max iterations</label>
            <input type="number" value={maxIterations} onChange={(e) => setMaxIterations(Number(e.target.value))} />
          </div>
          <div>
            <label>Max spend (USD)</label>
            <input type="number" step="0.5" value={maxSpend} onChange={(e) => setMaxSpend(Number(e.target.value))} />
          </div>
        </div>
        <div className="row">
          <div>
            <label>Max wall-clock (minutes)</label>
            <input type="number" value={maxWallMin} onChange={(e) => setMaxWallMin(Number(e.target.value))} />
          </div>
        </div>
      </div>

      <div className="group">
        <h3>System</h3>
        <div className="validation">
          <span className={elevation?.elevated ? 'ok' : ''}>
            {elevation?.supported
              ? elevation.elevated
                ? '✓ Running as Administrator'
                : '• Not elevated — some local fixes need admin rights'
              : `• Elevation not applicable on ${elevation?.platform ?? 'this platform'}`}
          </span>
          {elevation?.supported && !elevation.elevated && (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => void relaunchAdmin()}>Relaunch as Administrator</button>
            </div>
          )}
        </div>
      </div>

      <div className="group">
        <h3>Updates</h3>
        <div className="row">
          <div>
            <label>GitHub repo (owner/name)</label>
            <input value={updateRepo} onChange={(e) => setUpdateRepo(e.target.value)} placeholder="owner/troublecrack" />
          </div>
          <div>
            <label>Current version</label>
            <input value={appVersion} readOnly />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => void window.api.checkForUpdates()}>Check for Updates</button>
          <span className="muted">
            {update.state === 'downloaded'
              ? `Update ${update.version} downloaded.`
              : update.state === 'available'
                ? `Update ${update.version} available.`
                : update.state === 'deferred'
                  ? 'Update ready; will prompt after the session ends.'
                  : update.state === 'none'
                    ? 'Up to date.'
                    : update.state === 'error'
                      ? `Update check: ${update.message ?? 'error'}`
                      : update.state}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button disabled={busy} onClick={() => void validate()}>
          Test connection & key
        </button>
        {saved && <span className="pill ok">Saved</span>}
      </div>
    </div>
  )
}

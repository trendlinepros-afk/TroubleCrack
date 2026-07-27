import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { DiscoveredDevice, KvmAuthMode, SettingsValidation } from '@shared/types'

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5']

export function SettingsPage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const elevation = useStore((s) => s.elevation)
  const update = useStore((s) => s.update)
  const appVersion = useStore((s) => s.appVersion)

  const [deviceName, setDeviceName] = useState('')
  const [useTls, setUseTls] = useState(false)
  const [authMode, setAuthMode] = useState<KvmAuthMode>('auto')
  const [kvmPassword, setKvmPassword] = useState('')
  const [devices, setDevices] = useState<DiscoveredDevice[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [manualIp, setManualIp] = useState('')
  const [selectedNote, setSelectedNote] = useState('')

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
    setDeviceName(settings.kvm.deviceName ?? '')
    setUseTls(settings.kvm.useTls)
    setAuthMode(settings.kvm.authMode)
    setVaultPath(settings.vaultPath)
    setModel(settings.model)
    setMaxIterations(settings.caps.maxIterations)
    setMaxSpend(settings.caps.maxSpendUsd)
    setMaxWallMin(Math.round(settings.caps.maxWallClockMs / 60000))
    setUpdateRepo(settings.updateRepo ?? '')
  }, [settings])

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setDevices([])
    try {
      setDevices(await window.api.discoverDevices(useTls))
    } finally {
      setDiscovering(false)
    }
  }

  const useDevice = async (d: DiscoveredDevice): Promise<void> => {
    await window.api.selectKvmTarget({ host: d.host, useTls: d.useTls })
    const next = await window.api.saveSettings({
      kvm: { deviceName: d.name, deviceId: d.deviceId, hostname: d.hostname }
    })
    setSettings(next)
    setDeviceName(next.kvm.deviceName ?? '')
    setSelectedNote(
      d.deviceId || d.hostname
        ? `Selected ${d.name}. Its IP will be re-resolved automatically.`
        : `Selected ${d.name}. Its stable identity is captured on first connect.`
    )
  }

  const useManualIp = async (): Promise<void> => {
    if (!manualIp.trim()) return
    await window.api.selectKvmTarget({ host: manualIp.trim(), useTls })
    setSelectedNote(`Will connect to ${manualIp.trim()} next; the device identity is learned on connect.`)
  }

  const forget = async (): Promise<void> => {
    await window.api.forgetKvmTarget()
    const s = await window.api.getSettings()
    setSettings(s)
    setDeviceName('')
    setSelectedNote('')
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.saveSettings({
        kvm: { deviceName: deviceName || null, useTls, authMode, ...(kvmPassword ? { password: kvmPassword } : {}) },
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
        kvm: {
          deviceId: settings?.kvm.deviceId ?? null,
          deviceName: deviceName || null,
          hostname: settings?.kvm.hostname ?? null,
          useTls,
          authMode,
          password: kvmPassword
        },
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

  return (
    <div className="settings">
      <h2>Settings</h2>

      <div className="group">
        <h3>JetKVM device</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The JetKVM's IP is DHCP-assigned and never stored. TroubleCrack finds the
          device by identity (its <span className="mono">jetkvm-&lt;id&gt;.local</span> name)
          and re-resolves the current IP automatically — on launch and on any
          connection loss.
        </p>

        <div className="validation" style={{ marginBottom: 10 }}>
          {settings?.kvm.deviceName || settings?.kvm.deviceId ? (
            <span className="ok">
              ✓ Device: {settings.kvm.deviceName ?? settings.kvm.deviceId}
              {settings.kvm.hostname ? ` (${settings.kvm.hostname})` : ''}
            </span>
          ) : (
            <span>• No device selected yet — discover one below.</span>
          )}
          {(settings?.kvm.deviceId || settings?.kvm.deviceName) && (
            <button style={{ marginLeft: 10 }} onClick={() => void forget()}>
              Forget device
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button className="primary" disabled={discovering} onClick={() => void discover()}>
            {discovering ? 'Searching…' : 'Discover devices'}
          </button>
          <label style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={useTls}
              onChange={(e) => setUseTls(e.target.checked)}
              style={{ width: 'auto', marginRight: 6 }}
            />
            Use HTTPS/TLS
          </label>
        </div>

        {devices.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            {devices.map((d) => (
              <div key={d.id} className="attempt">
                <div style={{ flex: 1 }}>
                  <div>{d.name}</div>
                  <div className="meta">
                    {d.host}:{d.port} · {d.source}
                    {d.isSetup === false ? ' · not set up' : d.isSetup ? ' · configured' : ''}
                  </div>
                </div>
                <button className="ok" onClick={() => void useDevice(d)}>
                  Use this
                </button>
              </div>
            ))}
          </div>
        )}
        {devices.length === 0 && !discovering && (
          <div className="muted" style={{ marginBottom: 10 }}>
            No devices listed yet. Click <em>Discover devices</em> (mDNS + a local-subnet scan).
          </div>
        )}

        <div className="row">
          <div>
            <label>Manual IP (last resort)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={manualIp} onChange={(e) => setManualIp(e.target.value)} placeholder="192.168.1.50 or 192.168.1.50:80" />
              <button onClick={() => void useManualIp()}>Use IP</button>
            </div>
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
            <label>Device name (optional)</label>
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="Rack KVM #1" />
          </div>
          <div>
            <label>Password</label>
            <input
              type="password"
              value={kvmPassword}
              onChange={(e) => setKvmPassword(e.target.value)}
              placeholder="(leave blank to keep current)"
            />
          </div>
        </div>
        {selectedNote && <div className="validation ok" style={{ marginTop: 4 }}>{selectedNote}</div>}
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
            <label>API key {settings?.hasApiKey ? '(stored — encrypted, persists across updates)' : '(not set)'}</label>
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
              <button onClick={() => void window.api.relaunchAsAdmin()}>Relaunch as Administrator</button>
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
          Test discovery & key
        </button>
        {saved && <span className="pill ok">Saved</span>}
      </div>
    </div>
  )
}

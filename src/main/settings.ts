import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { app, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { JsonStore } from './store'
import { createLogger } from './logger'
import { DEFAULT_CAPS, DEFAULT_MODEL, VAULT_SUBDIR } from '@shared/constants'
import type {
  Settings,
  SettingsPatch,
  SettingsValidation,
  KvmSettings,
  ValidationResult
} from '@shared/types'

const logger = createLogger('settings')

interface PersistedSettings {
  kvm: Omit<KvmSettings, 'password'>
  model: string
  vaultPath: string | null
  caps: Settings['caps']
  defaultApprovalMode: Settings['defaultApprovalMode']
  updateRepo: string | null
}

interface Secrets {
  /** base64 safeStorage ciphertext, or null. */
  apiKey: string | null
  kvmPassword: string | null
}

const defaultPersisted: PersistedSettings = {
  kvm: { address: '', useTls: false, authMode: 'auto' },
  model: DEFAULT_MODEL,
  vaultPath: null,
  caps: { ...DEFAULT_CAPS },
  defaultApprovalMode: 'approval',
  updateRepo: null
}

const defaultSecrets: Secrets = { apiKey: null, kvmPassword: null }

let settingsStore: JsonStore<PersistedSettings> | null = null
let secretsStore: JsonStore<Secrets> | null = null

function stores(): { s: JsonStore<PersistedSettings>; sec: JsonStore<Secrets> } {
  if (!settingsStore) settingsStore = new JsonStore('settings.json', defaultPersisted)
  if (!secretsStore) secretsStore = new JsonStore('secrets.json', defaultSecrets)
  return { s: settingsStore, sec: secretsStore }
}

function encrypt(plain: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fall back to a marked base64 so we never persist raw plaintext silently.
      logger.warn('OS encryption unavailable; storing secret with weak local obfuscation')
      return 'b64:' + Buffer.from(plain, 'utf8').toString('base64')
    }
    return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  } catch (err) {
    logger.error('Failed to encrypt secret', err)
    return null
  }
}

function decrypt(stored: string | null): string | null {
  if (!stored) return null
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    }
    return null
  } catch (err) {
    logger.error('Failed to decrypt secret (was the OS keychain reset?)', err)
    return null
  }
}

export function loadSettings(): Settings {
  const { s, sec } = stores()
  const p = s.read()
  const secrets = sec.read()
  return {
    kvm: { ...p.kvm, password: '' },
    hasApiKey: secrets.apiKey !== null,
    model: p.model,
    vaultPath: p.vaultPath,
    caps: p.caps,
    defaultApprovalMode: p.defaultApprovalMode,
    updateRepo: p.updateRepo
  }
}

export function getApiKeyPlaintext(): string | null {
  return decrypt(stores().sec.read().apiKey)
}

export function getKvmPasswordPlaintext(): string | null {
  return decrypt(stores().sec.read().kvmPassword)
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const { s, sec } = stores()
  const cur = s.read()
  const curSecrets = sec.read()

  const next: PersistedSettings = {
    kvm: {
      address: patch.kvm?.address ?? cur.kvm.address,
      useTls: patch.kvm?.useTls ?? cur.kvm.useTls,
      authMode: patch.kvm?.authMode ?? cur.kvm.authMode
    },
    model: patch.model ?? cur.model,
    vaultPath: patch.vaultPath !== undefined ? patch.vaultPath : cur.vaultPath,
    caps: { ...cur.caps, ...(patch.caps ?? {}) },
    defaultApprovalMode: patch.defaultApprovalMode ?? cur.defaultApprovalMode,
    updateRepo: patch.updateRepo !== undefined ? patch.updateRepo : cur.updateRepo
  }

  const nextSecrets: Secrets = { ...curSecrets }
  if (patch.anthropicApiKeyPlaintext !== undefined) {
    nextSecrets.apiKey =
      patch.anthropicApiKeyPlaintext === null || patch.anthropicApiKeyPlaintext === ''
        ? null
        : encrypt(patch.anthropicApiKeyPlaintext)
  }
  if (patch.kvm?.password !== undefined) {
    nextSecrets.kvmPassword =
      patch.kvm.password === '' ? null : encrypt(patch.kvm.password)
  }

  await Promise.all([s.write(next), sec.write(nextSecrets)])
  logger.info('Settings saved')
  return loadSettings()
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseHostPort(address: string, useTls: boolean): { host: string; port: number } {
  const trimmed = address.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const [host, portStr] = trimmed.split(':')
  const port = portStr ? Number(portStr) : useTls ? 443 : 80
  return { host: host || '', port }
}

function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

async function validateKvm(kvm: KvmSettings): Promise<ValidationResult> {
  if (!kvm.address.trim()) return { ok: false, message: 'No JetKVM address set.' }
  const { host, port } = parseHostPort(kvm.address, kvm.useTls)
  if (!host) return { ok: false, message: 'Address could not be parsed.' }
  const reachable = await tcpReachable(host, port)
  if (!reachable) {
    return { ok: false, message: `Could not reach ${host}:${port}. Check the address and that the JetKVM is powered on.` }
  }
  return { ok: true, message: `Reachable at ${host}:${port}.` }
}

async function validateApiKey(key: string | null): Promise<ValidationResult> {
  if (!key) return { ok: false, message: 'No Anthropic API key set.' }
  try {
    const client = new Anthropic({ apiKey: key, timeout: 8000, maxRetries: 0 })
    await client.models.list()
    return { ok: true, message: 'API key accepted.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/401|authentication/i.test(msg)) return { ok: false, message: 'API key was rejected (401).' }
    return { ok: false, message: `Could not verify API key: ${msg}` }
  }
}

async function validateVault(vaultPath: string | null): Promise<ValidationResult> {
  if (!vaultPath) return { ok: true, message: 'No vault configured (self-learning disabled).' }
  try {
    const stat = await fs.stat(vaultPath)
    if (!stat.isDirectory()) return { ok: false, message: 'Vault path is not a directory.' }
    const sub = path.join(vaultPath, VAULT_SUBDIR)
    await fs.mkdir(sub, { recursive: true })
    const probe = path.join(sub, `.write-test-${process.pid}`)
    await fs.writeFile(probe, 'ok')
    await fs.unlink(probe)
    return { ok: true, message: `Vault is writable (${VAULT_SUBDIR}/ ready).` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Vault path is not writable: ${msg}` }
  }
}

export async function validateSettings(input: {
  kvm: KvmSettings
  anthropicApiKeyPlaintext?: string | null
  vaultPath: string | null
}): Promise<SettingsValidation> {
  // When the form leaves the API key blank, validate the stored one.
  const key =
    input.anthropicApiKeyPlaintext !== undefined && input.anthropicApiKeyPlaintext !== ''
      ? input.anthropicApiKeyPlaintext
      : getApiKeyPlaintext()
  const [kvm, apiKey, vault] = await Promise.all([
    validateKvm(input.kvm),
    validateApiKey(key),
    validateVault(input.vaultPath)
  ])
  return { kvm, apiKey, vault }
}

export function userDataDir(): string {
  return app.getPath('userData')
}

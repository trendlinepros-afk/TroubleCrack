import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { JsonStore } from './store'
import { discovery } from './discovery'
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
  autoExportSummary: boolean
  summaryExportDir: string | null
}

interface Secrets {
  /** base64 safeStorage ciphertext, or null. */
  apiKey: string | null
  kvmPassword: string | null
}

const defaultPersisted: PersistedSettings = {
  kvm: { deviceId: null, deviceName: null, hostname: null, useTls: false, authMode: 'auto' },
  model: DEFAULT_MODEL,
  vaultPath: null,
  caps: { ...DEFAULT_CAPS },
  defaultApprovalMode: 'approval',
  updateRepo: null,
  autoExportSummary: true,
  summaryExportDir: null
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
    updateRepo: p.updateRepo,
    // Default `undefined` (settings.json from before this field existed) to ON.
    autoExportSummary: p.autoExportSummary ?? true,
    summaryExportDir: p.summaryExportDir ?? null,
    summaryExportDirDefault: defaultSummaryDir()
  }
}

/** The folder auto-exported summaries go to when none is configured. Prefers the
 *  user's Documents folder (discoverable); falls back to userData if unavailable. */
export function defaultSummaryDir(): string {
  try {
    return path.join(app.getPath('documents'), 'TroubleCrack')
  } catch {
    return path.join(app.getPath('userData'), 'summaries')
  }
}

/** The effective folder for auto-exported summaries (configured or default). */
export function summaryExportDir(): string {
  return loadSettings().summaryExportDir || defaultSummaryDir()
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
      deviceId: patch.kvm?.deviceId !== undefined ? patch.kvm.deviceId : cur.kvm.deviceId,
      deviceName: patch.kvm?.deviceName !== undefined ? patch.kvm.deviceName : cur.kvm.deviceName,
      hostname: patch.kvm?.hostname !== undefined ? patch.kvm.hostname : cur.kvm.hostname,
      useTls: patch.kvm?.useTls ?? cur.kvm.useTls,
      authMode: patch.kvm?.authMode ?? cur.kvm.authMode
    },
    model: patch.model ?? cur.model,
    vaultPath: patch.vaultPath !== undefined ? patch.vaultPath : cur.vaultPath,
    caps: { ...cur.caps, ...(patch.caps ?? {}) },
    defaultApprovalMode: patch.defaultApprovalMode ?? cur.defaultApprovalMode,
    updateRepo: patch.updateRepo !== undefined ? patch.updateRepo : cur.updateRepo,
    autoExportSummary: patch.autoExportSummary ?? cur.autoExportSummary ?? true,
    summaryExportDir:
      patch.summaryExportDir !== undefined ? patch.summaryExportDir : cur.summaryExportDir ?? null
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

async function validateKvm(kvm: KvmSettings): Promise<ValidationResult> {
  try {
    // If we know the device, re-resolve it by its mDNS hostname / id.
    if (kvm.hostname || kvm.deviceId) {
      const d = kvm.hostname
        ? await discovery.resolveByHostname(kvm.hostname, kvm.useTls)
        : await discovery.resolveByDeviceId(kvm.deviceId as string, kvm.useTls)
      if (d) return { ok: true, message: `Resolved ${d.name} at ${d.host} (current IP).` }
    }
    // Otherwise scan the network for any JetKVM.
    const found = await discovery.discover(kvm.useTls)
    if (found.length === 0) {
      return {
        ok: false,
        message: 'No JetKVM found on the network. Power it on, or enter an IP manually below.'
      }
    }
    if (found.length === 1) {
      return { ok: true, message: `Found a JetKVM at ${found[0]!.host}.` }
    }
    return { ok: true, message: `Found ${found.length} JetKVMs — pick one below.` }
  } catch (err) {
    return { ok: false, message: `Discovery failed: ${err instanceof Error ? err.message : String(err)}` }
  }
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

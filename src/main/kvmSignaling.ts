import http from 'node:http'
import https from 'node:https'
import { createLogger } from './logger'
import { loadSettings, saveSettings, getKvmPasswordPlaintext } from './settings'
import { resolveTarget, setPreferredTarget } from './kvmResolve'
import { deviceIdToHostname, fetchDeviceInfo } from './discovery'
import type { KvmSignalResult } from '@shared/ipc-contract'

const logger = createLogger('kvm-signal')

interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  opts: {
    host: string
    port: number
    useTls: boolean
    method: string
    path: string
    cookie?: string
  },
  bodyObj?: unknown
): Promise<HttpResponse> {
  const mod = opts.useTls ? https : http
  const payload = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (payload) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = String(Buffer.byteLength(payload))
  }
  if (opts.cookie) headers['Cookie'] = opts.cookie

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = mod.request(
      {
        host: opts.host,
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers,
        timeout: 20_000,
        // JetKVM local TLS uses a self-signed cert; the device is on the LAN.
        rejectUnauthorized: false
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function extractAuthCookie(res: HttpResponse): string | null {
  const setCookie = res.headers['set-cookie']
  if (!setCookie) return null
  for (const c of setCookie) {
    const m = c.match(/authToken=([^;]+)/)
    if (m && m[1]) return `authToken=${m[1]}`
  }
  return null
}

async function login(
  host: string,
  port: number,
  useTls: boolean,
  password: string
): Promise<string> {
  const res = await request(
    { host, port, useTls, method: 'POST', path: '/auth/login-local' },
    { password }
  )
  if (res.status === 429) throw new Error('JetKVM login is rate-limited (too many attempts). Wait and retry.')
  if (res.status === 401) throw new Error('JetKVM rejected the password.')
  if (res.status >= 400) throw new Error(`JetKVM login failed (HTTP ${res.status}).`)
  const cookie = extractAuthCookie(res)
  if (!cookie) throw new Error('JetKVM login returned no auth cookie.')
  return cookie
}

async function postSession(
  host: string,
  port: number,
  useTls: boolean,
  offerB64: string,
  cookie?: string
): Promise<HttpResponse> {
  return request(
    { host, port, useTls, method: 'POST', path: '/webrtc/session', ...(cookie ? { cookie } : {}) },
    { sd: offerB64 }
  )
}

/** Persist the captured stable identity (never the IP) so future connects can
 *  re-resolve the device via mDNS after a DHCP change. */
async function persistIdentity(deviceId: string): Promise<void> {
  const cur = loadSettings().kvm
  const hostname = deviceIdToHostname(deviceId)
  if (cur.deviceId !== deviceId || cur.hostname !== hostname) {
    await saveSettings({
      kvm: { deviceId, hostname, deviceName: cur.deviceName ?? `JetKVM ${deviceId}` }
    })
    logger.info(`Captured device identity ${deviceId} (${hostname})`)
  }
}

/**
 * Perform the JetKVM WebRTC signaling handshake in the main process:
 * 1. resolve the device's CURRENT IP via discovery (never a stored IP),
 * 2. log in if needed (capturing the authToken cookie),
 * 3. POST the offer to /webrtc/session and return the answer,
 * 4. capture the device's stable id (GET /device) and persist it.
 * Doing all HTTP in main avoids the browser SameSite/CORS limits that block
 * cross-origin cookies from the renderer.
 */
export async function signalWebrtc(offerB64: string): Promise<KvmSignalResult> {
  const kvm = loadSettings().kvm
  const password = getKvmPasswordPlaintext() ?? ''

  const resolved = await resolveTarget(kvm)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, ...(resolved.needsPicker ? { needsPicker: true } : {}) }
  }
  const { host, port, useTls } = resolved.target

  try {
    let cookie: string | undefined
    if (kvm.authMode === 'password' && password) {
      cookie = await login(host, port, useTls, password)
    }

    let res = await postSession(host, port, useTls, offerB64, cookie)

    // Auto mode: if unauthorized, log in and retry once.
    if (res.status === 401 && kvm.authMode !== 'noPassword' && password) {
      cookie = await login(host, port, useTls, password)
      res = await postSession(host, port, useTls, offerB64, cookie)
    }

    if (res.status === 401) {
      return { ok: false, error: 'JetKVM requires a password. Set it in Settings.' }
    }
    if (res.status >= 400) {
      return { ok: false, error: `JetKVM /webrtc/session failed (HTTP ${res.status}).` }
    }

    let parsed: { sd?: string }
    try {
      parsed = JSON.parse(res.body) as { sd?: string }
    } catch {
      return { ok: false, error: 'JetKVM returned a non-JSON session response.' }
    }
    if (!parsed.sd) return { ok: false, error: 'JetKVM session response had no answer SDP.' }

    // Best-effort: capture the stable device identity for future re-resolution.
    const info = await fetchDeviceInfo(host, port, useTls, cookie).catch(() => null)
    if (info?.deviceId) {
      await persistIdentity(info.deviceId).catch(() => undefined)
      // Identity captured — the transient picker/manual choice can be released.
      setPreferredTarget(null)
    }

    return { ok: true, answerB64: parsed.sd }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`Signaling failed: ${message}`)
    return { ok: false, error: message }
  }
}

import http from 'node:http'
import https from 'node:https'
import { createLogger } from './logger'
import type { KvmSignalRequest, KvmSignalResult } from '@shared/ipc-contract'

const logger = createLogger('kvm-signal')

interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function parseHostPort(address: string, useTls: boolean): { host: string; port: number } {
  const trimmed = address.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const [host, portStr] = trimmed.split(':')
  const port = portStr ? Number(portStr) : useTls ? 443 : 80
  return { host: host || '', port }
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

/**
 * Perform the JetKVM WebRTC signaling handshake in the main process: log in if
 * needed (capturing the authToken cookie), then POST the offer to
 * /webrtc/session and return the answer. Doing this in main avoids the browser
 * SameSite/CORS limits that block cross-origin cookies from the renderer.
 */
export async function signalWebrtc(req: KvmSignalRequest): Promise<KvmSignalResult> {
  const { host, port } = parseHostPort(req.address, req.useTls)
  if (!host) return { ok: false, error: 'JetKVM address is empty or invalid.' }

  try {
    let cookie: string | undefined
    if (req.authMode === 'password' && req.password) {
      cookie = await login(host, port, req.useTls, req.password)
    }

    let res = await postSession(host, port, req.useTls, req.offerB64, cookie)

    // Auto mode: if unauthorized, log in and retry once.
    if (res.status === 401 && req.authMode !== 'noPassword' && req.password) {
      cookie = await login(host, port, req.useTls, req.password)
      res = await postSession(host, port, req.useTls, req.offerB64, cookie)
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
    return { ok: true, answerB64: parsed.sd }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`Signaling failed: ${message}`)
    return { ok: false, error: message }
  }
}

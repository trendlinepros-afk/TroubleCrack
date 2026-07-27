import http from 'node:http'
import https from 'node:https'

interface HttpResult {
  status: number
  body: string
}

function get(
  host: string,
  port: number,
  useTls: boolean,
  path: string,
  cookie: string | undefined,
  timeoutMs: number
): Promise<HttpResult> {
  const mod = useTls ? https : http
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (cookie) headers['Cookie'] = cookie
  return new Promise<HttpResult>((resolve, reject) => {
    const req = mod.request(
      { host, port, method: 'GET', path, headers, timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        // Cap the body — a fingerprint response is tiny; anything huge isn't a JetKVM.
        res.on('data', (c) => {
          if (data.length < 8192) data += c
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

export interface DeviceProbe {
  isSetup: boolean | null
}

/**
 * Identify a JetKVM by its public `GET /device/status` endpoint, which returns
 * `{"isSetup": bool}` with permissive CORS. Returns the probe on a match, or
 * null for anything that isn't a JetKVM (so a subnet scan can filter).
 */
export async function probeDeviceStatus(
  host: string,
  port: number,
  useTls: boolean,
  timeoutMs = 1500
): Promise<DeviceProbe | null> {
  try {
    const res = await get(host, port, useTls, '/device/status', undefined, timeoutMs)
    if (res.status !== 200) return null
    const json = JSON.parse(res.body) as Record<string, unknown>
    if (typeof json.isSetup === 'boolean') return { isSetup: json.isSetup }
    return null
  } catch {
    return null
  }
}

export interface DeviceInfo {
  deviceId: string | null
  authMode: string | null
}

/**
 * Fetch the stable device identity from the (protected) `GET /device`. In
 * noPassword mode this needs no cookie; in password mode pass the authToken
 * cookie. Returns null if unavailable — identity capture is best-effort.
 */
export async function fetchDeviceInfo(
  host: string,
  port: number,
  useTls: boolean,
  cookie: string | undefined,
  timeoutMs = 3000
): Promise<DeviceInfo | null> {
  try {
    const res = await get(host, port, useTls, '/device', cookie, timeoutMs)
    if (res.status !== 200) return null
    const json = JSON.parse(res.body) as Record<string, unknown>
    return {
      deviceId: typeof json.deviceId === 'string' ? json.deviceId : null,
      authMode: typeof json.authMode === 'string' ? json.authMode : null
    }
  } catch {
    return null
  }
}

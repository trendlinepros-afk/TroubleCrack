import makeMdns from 'multicast-dns'
import { createLogger } from '../logger'

const logger = createLogger('mdns')

/**
 * Resolve a JetKVM `.local` hostname (e.g. `jetkvm-<id>.local`) to its current
 * IP via a direct mDNS A-record query. JetKVM firmware uses pion/mdns, which is
 * a hostname responder (it answers A/AAAA queries for its `.local` names) rather
 * than a DNS-SD service advertiser — so this direct A-query, not a service
 * browse, is what actually resolves a known device after its DHCP IP changes.
 */
export function resolveHostname(hostname: string, timeoutMs = 1500): Promise<string[]> {
  const name = hostname.toLowerCase()
  return new Promise<string[]>((resolve) => {
    let mdns: ReturnType<typeof makeMdns> | null = null
    const found = new Set<string>()
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      try {
        mdns?.destroy()
      } catch {
        /* ignore */
      }
      resolve([...found])
    }

    try {
      mdns = makeMdns()
      mdns.on('response', (response) => {
        for (const a of response.answers ?? []) {
          if ((a.type === 'A' || a.type === 'AAAA') && a.name.toLowerCase() === name) {
            if (typeof a.data === 'string') found.add(a.data)
          }
        }
        // We have what we need; return promptly rather than waiting the full window.
        if (found.size > 0) finish()
      })
      mdns.on('error', () => finish())
      mdns.query({ questions: [{ name, type: 'A' }] })
      mdns.query({ questions: [{ name, type: 'AAAA' }] })
    } catch (err) {
      logger.warn('mDNS query failed to start')
      finish()
      return
    }

    setTimeout(finish, timeoutMs)
  })
}

export interface DnsSdHit {
  name: string
  host: string
  port: number
}

/**
 * Best-effort DNS-SD service browse. JetKVM does not advertise a DNS-SD service
 * (pion/mdns is hostname-only), so this usually returns nothing — but it honors
 * the "try mDNS/DNS-SD first" tier and will catch any device that does advertise
 * an HTTP service on the LAN, which we then fingerprint.
 */
export function browseDnsSd(timeoutMs = 2000): Promise<DnsSdHit[]> {
  return new Promise<DnsSdHit[]>((resolve) => {
    let mdns: ReturnType<typeof makeMdns> | null = null
    const srv = new Map<string, { host?: string; port?: number }>()
    const aRecords = new Map<string, string>()
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      try {
        mdns?.destroy()
      } catch {
        /* ignore */
      }
      const hits: DnsSdHit[] = []
      for (const [name, s] of srv) {
        const host = s.host ? aRecords.get(s.host.toLowerCase()) ?? s.host : undefined
        if (host && s.port) hits.push({ name, host, port: s.port })
      }
      resolve(hits)
    }

    try {
      mdns = makeMdns()
      mdns.on('response', (response) => {
        for (const a of [...(response.answers ?? []), ...(response.additionals ?? [])]) {
          if (a.type === 'SRV' && typeof a.data === 'object' && a.data) {
            const d = a.data as { target?: string; port?: number }
            srv.set(a.name, { host: d.target, port: d.port })
          } else if (a.type === 'A' && typeof a.data === 'string') {
            aRecords.set(a.name.toLowerCase(), a.data)
          }
        }
      })
      mdns.on('error', () => finish())
      mdns.query({ questions: [{ name: '_http._tcp.local', type: 'PTR' }] })
      mdns.query({ questions: [{ name: '_services._dns-sd._udp.local', type: 'PTR' }] })
    } catch {
      finish()
      return
    }

    setTimeout(finish, timeoutMs)
  })
}

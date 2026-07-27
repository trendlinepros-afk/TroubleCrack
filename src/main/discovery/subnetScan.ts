import os from 'node:os'
import net from 'node:net'
import { hostsForSubnet } from './net'
import { probeDeviceStatus } from './fingerprint'
import { createLogger } from '../logger'
import type { DiscoveredDevice } from '@shared/types'

const logger = createLogger('subnet-scan')

/** Quick TCP connect check — is the port open on this host? */
function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok: boolean): void => {
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

/** All host IPs on the local IPv4 subnets (clamped per interface for speed). */
export function localHosts(): string[] {
  const set = new Set<string>()
  const ifaces = os.networkInterfaces()
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.netmask) {
        try {
          for (const h of hostsForSubnet(a.address, a.netmask)) set.add(h)
        } catch {
          /* skip malformed */
        }
      }
    }
  }
  return [...set]
}

async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = index++
      if (i >= items.length) return
      results.push(await fn(items[i]!))
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Scan the local subnet(s) for JetKVM devices: a fast TCP-open pass, then an
 * HTTP fingerprint (`/device/status`) on the hosts that answered. Returns one
 * DiscoveredDevice per JetKVM found, identified by IP (the stable device id is
 * captured later, during the authenticated handshake).
 */
export async function scanForJetKvm(
  useTls: boolean,
  opts: { tcpTimeoutMs?: number; concurrency?: number; onFound?: (d: DiscoveredDevice) => void } = {}
): Promise<DiscoveredDevice[]> {
  const port = useTls ? 443 : 80
  const hosts = localHosts()
  logger.info(`Scanning ${hosts.length} hosts on port ${port}`)
  const tcpTimeout = opts.tcpTimeoutMs ?? 400
  const concurrency = opts.concurrency ?? 96

  const open = (await runPool(hosts, concurrency, async (h) => ((await tcpOpen(h, port, tcpTimeout)) ? h : null))).filter(
    (h): h is string => h !== null
  )

  const devices: DiscoveredDevice[] = []
  await runPool(open, 24, async (host) => {
    const probe = await probeDeviceStatus(host, port, useTls)
    if (probe) {
      const d: DiscoveredDevice = {
        id: `${host}:${port}`,
        name: `JetKVM at ${host}`,
        host,
        port,
        useTls,
        hostname: null,
        deviceId: null,
        isSetup: probe.isSetup,
        source: 'scan'
      }
      devices.push(d)
      opts.onFound?.(d)
    }
  })
  logger.info(`Scan found ${devices.length} JetKVM device(s)`)
  return devices
}

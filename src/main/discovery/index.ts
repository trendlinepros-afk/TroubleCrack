import { createLogger } from '../logger'
import { scanForJetKvm } from './subnetScan'
import { browseDnsSd, resolveHostname } from './mdns'
import { probeDeviceStatus } from './fingerprint'
import { deviceIdToHostname } from './net'
import type { DiscoveredDevice } from '@shared/types'

const logger = createLogger('discovery')

export * from './net'
export * from './fingerprint'

/** Parse the device id out of a jetkvm-<id>.local hostname. */
function deviceIdFromHostname(hostname: string): string | null {
  const m = hostname.toLowerCase().match(/^jetkvm-(.+)\.local$/)
  return m?.[1] ?? null
}

function dedupeByHost(devices: DiscoveredDevice[]): DiscoveredDevice[] {
  const byHost = new Map<string, DiscoveredDevice>()
  for (const d of devices) {
    const existing = byHost.get(d.host)
    // Prefer an entry that carries a hostname/deviceId (richer identity).
    if (!existing || (!existing.hostname && d.hostname)) byHost.set(d.host, d)
  }
  return [...byHost.values()]
}

/**
 * Device discovery. Tiers, in order: (1) mDNS/DNS-SD, (2) a fingerprinted
 * subnet scan, (3) manual entry (handled by the caller). Discovery runs on
 * launch and on every connection loss so a DHCP-reassigned IP is picked up
 * automatically — the IP is never persisted.
 */
export class DiscoveryService {
  /** Find every JetKVM on the local network (for the picker / first setup). */
  async discover(useTls: boolean): Promise<DiscoveredDevice[]> {
    const [dnsSdHits, scanned] = await Promise.all([
      browseDnsSd().catch(() => []),
      scanForJetKvm(useTls).catch((err) => {
        logger.warn(`Subnet scan failed: ${err instanceof Error ? err.message : err}`)
        return []
      })
    ])

    // Fingerprint DNS-SD hits to confirm they're JetKVMs (usually none — pion
    // mdns doesn't advertise services — but honors the DNS-SD tier).
    const mdnsDevices: DiscoveredDevice[] = []
    for (const hit of dnsSdHits) {
      const probe = await probeDeviceStatus(hit.host, hit.port, useTls).catch(() => null)
      if (probe) {
        mdnsDevices.push({
          id: hit.name || `${hit.host}:${hit.port}`,
          name: hit.name || `JetKVM at ${hit.host}`,
          host: hit.host,
          port: hit.port,
          useTls,
          hostname: hit.name.endsWith('.local') ? hit.name : null,
          deviceId: null,
          isSetup: probe.isSetup,
          source: 'mdns'
        })
      }
    }

    return dedupeByHost([...mdnsDevices, ...scanned])
  }

  /** Re-resolve a known device to its current IP via its `.local` hostname. */
  async resolveByHostname(hostname: string, useTls: boolean): Promise<DiscoveredDevice | null> {
    const port = useTls ? 443 : 80
    const ips = await resolveHostname(hostname).catch(() => [])
    for (const host of ips) {
      const probe = await probeDeviceStatus(host, port, useTls).catch(() => null)
      if (probe) {
        return {
          id: deviceIdFromHostname(hostname) ?? hostname,
          name: hostname,
          host,
          port,
          useTls,
          hostname,
          deviceId: deviceIdFromHostname(hostname),
          isSetup: probe.isSetup,
          source: 'mdns'
        }
      }
    }
    return null
  }

  /** Re-resolve a known device by its device id (via its derived hostname). */
  async resolveByDeviceId(deviceId: string, useTls: boolean): Promise<DiscoveredDevice | null> {
    return this.resolveByHostname(deviceIdToHostname(deviceId), useTls)
  }
}

export const discovery = new DiscoveryService()

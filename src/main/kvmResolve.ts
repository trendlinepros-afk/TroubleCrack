import { discovery } from './discovery'
import { createLogger } from './logger'
import type { KvmSettings } from '@shared/types'

const logger = createLogger('kvm-resolve')

export interface ResolvedTarget {
  host: string
  port: number
  useTls: boolean
}

export type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; error: string; needsPicker?: boolean }

/**
 * A transient, in-memory preferred target set by the device picker or manual IP
 * entry. It is deliberately NOT persisted — the IP is ephemeral. It is consumed
 * once the device's stable identity has been captured on a successful connect.
 */
let preferred: ResolvedTarget | null = null

export function setPreferredTarget(t: ResolvedTarget | null): void {
  preferred = t
}

export function getPreferredTarget(): ResolvedTarget | null {
  return preferred
}

/**
 * Resolve the JetKVM's current IP for a connection attempt. Order: a transient
 * picker/manual selection, then the stored device's mDNS hostname, then its
 * device id, then a subnet scan (auto-pick if exactly one, else ask the admin to
 * pick). Runs fresh every attempt, so a DHCP-reassigned IP is picked up.
 */
export async function resolveTarget(kvm: KvmSettings): Promise<ResolveResult> {
  const useTls = kvm.useTls

  if (preferred) {
    logger.debug(`Using preferred target ${preferred.host}:${preferred.port}`)
    return { ok: true, target: preferred }
  }

  if (kvm.hostname) {
    const d = await discovery.resolveByHostname(kvm.hostname, useTls).catch(() => null)
    if (d) return { ok: true, target: { host: d.host, port: d.port, useTls } }
  }

  if (kvm.deviceId) {
    const d = await discovery.resolveByDeviceId(kvm.deviceId, useTls).catch(() => null)
    if (d) return { ok: true, target: { host: d.host, port: d.port, useTls } }
  }

  const found = await discovery.discover(useTls).catch(() => [])
  if (found.length === 1) {
    return { ok: true, target: { host: found[0]!.host, port: found[0]!.port, useTls } }
  }
  if (found.length === 0) {
    return {
      ok: false,
      error: 'No JetKVM found on the network. Check it is powered on, or enter an IP in Settings.'
    }
  }
  return { ok: false, error: `Found ${found.length} JetKVMs — pick one in Settings.`, needsPicker: true }
}

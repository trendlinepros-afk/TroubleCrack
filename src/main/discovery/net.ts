/**
 * Pure network helpers for discovery — no I/O, so they are unit-testable.
 */

export function ipToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`)
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

export function maskToPrefix(netmask: string): number {
  const n = ipToInt(netmask)
  let prefix = 0
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) prefix++
    else break
  }
  return prefix
}

/**
 * Enumerate the usable host IPs on the subnet containing `ip`. To keep scans
 * fast and safe, subnets larger than `maxHosts` are clamped to the /24 that
 * contains `ip` (so a /16 becomes a 254-host /24 sweep, not 65k). Excludes the
 * network and broadcast addresses.
 */
export function hostsForSubnet(ip: string, netmask: string, maxHosts = 1024): string[] {
  const ipInt = ipToInt(ip)
  let prefix = maskToPrefix(netmask)
  const hostBits = 32 - prefix
  const total = hostBits >= 31 ? 0 : 2 ** hostBits
  if (total - 2 > maxHosts || prefix < 24) prefix = 24
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (ipInt & mask) >>> 0
  const count = 2 ** (32 - prefix)
  const hosts: string[] = []
  for (let i = 1; i < count - 1; i++) {
    hosts.push(intToIp((network + i) >>> 0))
  }
  return hosts
}

/** JetKVM's default mDNS hostname for a device id (see hw.go GetDefaultHostname). */
export function deviceIdToHostname(deviceId: string): string {
  const clean = deviceId.trim().toLowerCase().replace(/\.local$/, '')
  return `jetkvm-${clean}.local`
}

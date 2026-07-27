import { describe, it, expect } from 'vitest'
import {
  ipToInt,
  intToIp,
  maskToPrefix,
  hostsForSubnet,
  deviceIdToHostname
} from '../src/main/discovery/net'

describe('discovery net helpers', () => {
  it('round-trips IPv4 <-> int', () => {
    for (const ip of ['192.168.1.50', '10.0.0.1', '255.255.255.255', '0.0.0.0']) {
      expect(intToIp(ipToInt(ip))).toBe(ip)
    }
  })

  it('rejects malformed IPv4', () => {
    expect(() => ipToInt('999.1.1.1')).toThrow()
    expect(() => ipToInt('1.2.3')).toThrow()
  })

  it('converts netmask to prefix', () => {
    expect(maskToPrefix('255.255.255.0')).toBe(24)
    expect(maskToPrefix('255.255.0.0')).toBe(16)
    expect(maskToPrefix('255.255.255.128')).toBe(25)
    expect(maskToPrefix('255.255.255.252')).toBe(30)
  })

  it('enumerates a /24 without network or broadcast', () => {
    const hosts = hostsForSubnet('192.168.1.50', '255.255.255.0')
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.1.1')
    expect(hosts[hosts.length - 1]).toBe('192.168.1.254')
    expect(hosts).not.toContain('192.168.1.0')
    expect(hosts).not.toContain('192.168.1.255')
  })

  it('clamps a large subnet to the containing /24 for scan safety', () => {
    const hosts = hostsForSubnet('10.4.5.9', '255.255.0.0')
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('10.4.5.1')
    expect(hosts).toContain('10.4.5.9')
  })

  it('derives the JetKVM mDNS hostname from a device id (lowercased)', () => {
    expect(deviceIdToHostname('AbC123')).toBe('jetkvm-abc123.local')
  })

  it('strips a trailing .local when deriving the hostname', () => {
    expect(deviceIdToHostname('abc.local')).toBe('jetkvm-abc.local')
  })
})

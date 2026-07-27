import { describe, it, expect } from 'vitest'
import { evaluateBlocklist } from '../src/shared/blocklist'

describe('blocklist', () => {
  const blocked = (detail: string): boolean =>
    evaluateBlocklist('local_powershell', detail).blocked

  it('blocks formatting a volume', () => {
    expect(blocked('format C: /q')).toBe(true)
    expect(blocked('Format-Volume -DriveLetter D')).toBe(true)
  })

  it('blocks destructive diskpart subcommands', () => {
    expect(blocked('diskpart')).toBe(true)
    expect(blocked('clean all')).toBe(true)
    expect(blocked('delete partition override')).toBe(true)
  })

  it('blocks recursive del /s', () => {
    expect(blocked('del /s /q C:\\data')).toBe(true)
    expect(blocked('rd /s /q C:\\temp2')).toBe(true)
  })

  it('blocks partition-table changes', () => {
    expect(blocked('Clear-Disk -Number 0 -RemoveData')).toBe(true)
    expect(blocked('New-Partition -DiskNumber 1 -UseMaximumSize')).toBe(true)
  })

  it('blocks BIOS/firmware setting changes', () => {
    expect(blocked('set BIOS boot order to configure UEFI')).toBe(true)
  })

  it('blocks BitLocker operations', () => {
    expect(blocked('manage-bde -unlock C: -RecoveryPassword 111')).toBe(true)
    expect(blocked('Enable-BitLocker -MountPoint C:')).toBe(true)
  })

  it('blocks registry deletions', () => {
    expect(blocked('reg delete HKLM\\Software\\Foo /f')).toBe(true)
    expect(blocked('Remove-Item HKLM:\\Software\\Foo -Recurse')).toBe(true)
  })

  it('blocks disabling Defender / security services', () => {
    expect(blocked('Set-MpPreference -DisableRealtimeMonitoring $true')).toBe(true)
    expect(blocked('Stop-Service WinDefend')).toBe(true)
  })

  it('blocks Remove-Item -Recurse outside temp, allows inside temp', () => {
    expect(blocked('Remove-Item C:\\Users\\me\\Documents -Recurse -Force')).toBe(true)
    expect(blocked('Remove-Item "$env:TEMP\\*" -Recurse -Force')).toBe(false)
    expect(blocked('Remove-Item C:\\Windows\\Temp\\stuff -Recurse')).toBe(false)
  })

  it('allows benign diagnostics', () => {
    expect(blocked('Get-Service wuauserv')).toBe(false)
    expect(blocked('ipconfig /flushdns')).toBe(false)
    expect(blocked('Get-Volume')).toBe(false)
    expect(blocked('bootrec /rebuildbcd')).toBe(false)
  })

  it('skips evaluation for non-command kinds', () => {
    expect(evaluateBlocklist('local_screenshot', 'format C:').blocked).toBe(false)
    expect(evaluateBlocklist('wait', 'diskpart clean').blocked).toBe(false)
    expect(evaluateBlocklist('kvm_move', 'anything').blocked).toBe(false)
  })

  it('reports a reason when blocked', () => {
    const hit = evaluateBlocklist('local_powershell', 'format C:')
    expect(hit.reason).toBeTruthy()
  })
})

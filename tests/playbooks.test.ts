import { describe, it, expect } from 'vitest'
import {
  ALL_PLAYBOOKS,
  DEFAULT_PLAYBOOK_ID,
  choosePlaybook,
  getPlaybook,
  playbooksForMode
} from '../src/shared/playbooks'

describe('playbooks', () => {
  it('has the no-boot Windows ladder with 9 steps ending in a terminal step', () => {
    const pb = getPlaybook('no-boot-windows')!
    expect(pb).toBeDefined()
    expect(pb.steps).toHaveLength(9)
    expect(pb.steps[pb.steps.length - 1]!.terminal).toBe(true)
  })

  it('has five local playbooks', () => {
    expect(playbooksForMode('local')).toHaveLength(5)
  })

  it('every step has id, name, and goal', () => {
    for (const pb of ALL_PLAYBOOKS) {
      for (const step of pb.steps) {
        expect(step.id).toBeTruthy()
        expect(step.name).toBeTruthy()
        expect(step.goal.length).toBeGreaterThan(10)
      }
    }
  })

  it('routes a VPN problem to the local network playbook', () => {
    expect(choosePlaybook('local', "my VPN won't connect").id).toBe('local-network')
  })

  it('routes a stuck-update problem to the Windows Update playbook', () => {
    expect(choosePlaybook('local', 'windows update is stuck').id).toBe('local-windows-update')
  })

  it('defaults KVM mode to the no-boot ladder', () => {
    expect(choosePlaybook('kvm', 'anything at all').id).toBe(DEFAULT_PLAYBOOK_ID.kvm)
  })

  it('falls back to the mode default when nothing matches', () => {
    expect(choosePlaybook('local', 'zzzz qqqq').id).toBe(DEFAULT_PLAYBOOK_ID.local)
  })
})

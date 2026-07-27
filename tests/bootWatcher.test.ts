import { describe, it, expect } from 'vitest'
import { watchBoot, type BootWatchDeps } from '../src/main/orchestrator/bootWatcher'
import type { Observation } from '../src/shared/types'

function obs(failureClass: Observation['failureClass'], stopCode: string | null, confident = true): Observation {
  return { failureClass, stopCode, summary: `${failureClass}`, confident }
}

/** A virtual clock: sleep advances time, so tests run instantly. */
function makeDeps(script: Observation[], overrides: Partial<BootWatchDeps> = {}): BootWatchDeps {
  let t = 0
  let i = 0
  return {
    pollIntervalMs: 5,
    timeoutMs: 1000,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    classify: async () => script[Math.min(i++, script.length - 1)]!,
    shouldAbort: () => false,
    ...overrides
  }
}

describe('boot watcher', () => {
  it('returns FIXED when the machine reaches the desktop', async () => {
    const res = await watchBoot(obs('bsod', '0x7B'), makeDeps([obs('desktop', null)]))
    expect(res.outcome).toBe('FIXED')
  })

  it('returns FIXED at the login screen too', async () => {
    const res = await watchBoot(null, makeDeps([obs('login', null)]))
    expect(res.outcome).toBe('FIXED')
  })

  it('returns SAME_FAILURE when the same failure persists', async () => {
    const prior = obs('bsod', '0x7B')
    const res = await watchBoot(prior, makeDeps([obs('bsod', '0x7B'), obs('bsod', '0x7B')]))
    expect(res.outcome).toBe('SAME_FAILURE')
  })

  it('returns NEW_FAILURE when a different, stable failure appears', async () => {
    const prior = obs('bsod', '0x7B')
    const res = await watchBoot(
      prior,
      makeDeps([obs('boot_device_not_found', null), obs('boot_device_not_found', null)])
    )
    expect(res.outcome).toBe('NEW_FAILURE')
  })

  it('does not conclude on a single unstable observation (waits for stability)', async () => {
    // Different classes back-to-back never reach stableCount>=1 until they match.
    const prior = obs('bsod', '0x7B')
    const res = await watchBoot(
      prior,
      makeDeps([obs('spinning_loop', null), obs('bsod', '0x7B'), obs('bsod', '0x7B')])
    )
    expect(res.outcome).toBe('SAME_FAILURE')
  })

  it('falls back to a best call on timeout with low-confidence frames', async () => {
    const res = await watchBoot(
      null,
      makeDeps([obs('bsod', '0x7B', false)], { timeoutMs: 40, pollIntervalMs: 5 })
    )
    // Never confident, so it times out; last frame is a bsod, no prior → baseline.
    expect(res.outcome).toBe('SAME_FAILURE')
    expect(res.observation.failureClass).toBe('bsod')
  })

  it('returns UNKNOWN when aborted before any classification', async () => {
    const res = await watchBoot(null, makeDeps([obs('desktop', null)], { shouldAbort: () => true }))
    expect(res.outcome).toBe('UNKNOWN')
  })
})

import type { BootOutcome, Observation } from '@shared/types'

export interface BootWatchDeps {
  pollIntervalMs: number
  timeoutMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Capture the current frame and classify it. */
  classify: () => Promise<Observation>
  onProgress?: (elapsedMs: number, obs: Observation) => void
  shouldAbort: () => boolean
}

export interface BootWatchResult {
  outcome: BootOutcome
  observation: Observation
}

const UNKNOWN_OBS: Observation = {
  failureClass: 'unknown',
  stopCode: null,
  summary: 'Could not determine screen state.',
  confident: false
}

function sameFailure(a: Observation, b: Observation): boolean {
  return a.failureClass === b.failureClass && (a.stopCode ?? '') === (b.stopCode ?? '')
}

function isBooted(o: Observation): boolean {
  return o.failureClass === 'desktop' || o.failureClass === 'login'
}

/**
 * Poll frames for up to `timeoutMs` after a reboot and classify the outcome as
 * FIXED / SAME_FAILURE / NEW_FAILURE (relative to `prior`). We require a
 * non-booted classification to persist across two polls before concluding a
 * failure, so a mid-boot transient isn't mistaken for the final state. All time
 * and classification is injected, so this is fully testable.
 */
export async function watchBoot(
  prior: Observation | null,
  deps: BootWatchDeps
): Promise<BootWatchResult> {
  const start = deps.now()
  let last: Observation | null = null
  let stableCount = 0

  while (!deps.shouldAbort() && deps.now() - start < deps.timeoutMs) {
    let obs: Observation
    try {
      obs = await deps.classify()
    } catch {
      obs = UNKNOWN_OBS
    }
    deps.onProgress?.(deps.now() - start, obs)

    if (isBooted(obs)) {
      return { outcome: 'FIXED', observation: obs }
    }

    if (last && sameFailure(last, obs)) stableCount += 1
    else stableCount = 0
    last = obs

    if (stableCount >= 1 && obs.confident) {
      return { outcome: decideNonFixed(prior, obs), observation: obs }
    }

    await deps.sleep(deps.pollIntervalMs)
  }

  // Timed out (or aborted): make the best call from the last observation.
  if (deps.shouldAbort()) return { outcome: 'UNKNOWN', observation: last ?? UNKNOWN_OBS }
  if (!last) return { outcome: 'UNKNOWN', observation: UNKNOWN_OBS }
  if (isBooted(last)) return { outcome: 'FIXED', observation: last }
  return { outcome: decideNonFixed(prior, last), observation: last }
}

function decideNonFixed(prior: Observation | null, obs: Observation): BootOutcome {
  if (!prior) return 'SAME_FAILURE' // establishes the baseline failure
  if (sameFailure(prior, obs)) return 'SAME_FAILURE'
  return 'NEW_FAILURE'
}

export { sameFailure as __sameFailure, decideNonFixed as __decideNonFixed }

import type { TargetMode } from '../types'
import type { Playbook } from './types'
import { noBootWindows } from './noBootWindows'
import { localPlaybooks } from './local'

export * from './types'
export { noBootWindows } from './noBootWindows'
export {
  localPlaybooks,
  localNetwork,
  localWindowsUpdate,
  localPrinter,
  localDiskSpace,
  localSlowMachine
} from './local'

export const ALL_PLAYBOOKS: Playbook[] = [noBootWindows, ...localPlaybooks]

export const DEFAULT_PLAYBOOK_ID: Record<TargetMode, string> = {
  kvm: noBootWindows.id,
  local: localPlaybooks[0]!.id
}

export function getPlaybook(id: string): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.id === id)
}

export function playbooksForMode(mode: TargetMode): Playbook[] {
  return ALL_PLAYBOOKS.filter((p) => p.mode === mode)
}

/**
 * Pick a playbook for a problem description in a given mode. Very simple tag
 * scoring — enough to route "my VPN won't connect" to the network playbook.
 * Falls back to the mode default.
 */
export function choosePlaybook(mode: TargetMode, problem: string): Playbook {
  const candidates = playbooksForMode(mode)
  const fallback = getPlaybook(DEFAULT_PLAYBOOK_ID[mode]) ?? candidates[0]!
  const text = problem.toLowerCase()
  let best: Playbook | null = null
  let bestScore = 0
  for (const pb of candidates) {
    let score = 0
    for (const tag of pb.tags) {
      if (text.includes(tag.replace(/-/g, ' ')) || text.includes(tag)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = pb
    }
  }
  return bestScore > 0 && best ? best : fallback
}

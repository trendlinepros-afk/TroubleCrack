/**
 * Hard blocklist. Any proposed action whose detail matches one of these
 * patterns is forced to require human approval, even in Auto mode. This is a
 * safety backstop, not a security boundary — it never *executes*, it only
 * gates. Matching is deliberately conservative and case-insensitive.
 */
import type { ProposedActionKind } from './types'

export interface BlocklistHit {
  blocked: boolean
  reason?: string
}

interface Rule {
  reason: string
  test: (detail: string) => boolean
}

/** Paths considered "temp" where Remove-Item -Recurse is allowed without a hit. */
const TEMP_PATH = /(\\temp\\|\/temp\/|\\tmp\\|\/tmp\/|%temp%|\$env:temp|windows\\temp|appdata\\local\\temp)/i

function rx(re: RegExp): (d: string) => boolean {
  return (d) => re.test(d)
}

const RULES: Rule[] = [
  {
    reason: 'Formats a volume (destructive)',
    test: rx(/\bformat\b\s+[a-z]:|\bformat-volume\b|\bformat\s+\/[a-z]/i)
  },
  {
    reason: 'diskpart destructive subcommand (clean/delete)',
    test: (d) => /\bdiskpart\b/i.test(d) || /\b(clean(\s+all)?|delete\s+(partition|volume|disk))\b/i.test(d)
  },
  {
    reason: 'Recursive delete (del /s or rm -rf style)',
    test: rx(/\bdel\b[^\n]*\/s\b|\brmdir\b[^\n]*\/s\b|\brd\b[^\n]*\/s\b|\brm\b\s+-[a-z]*r[a-z]*f|\brm\b\s+-[a-z]*f[a-z]*r/i)
  },
  {
    reason: 'Partition table change',
    test: rx(/\b(new-partition|remove-partition|resize-partition|set-partition|initialize-disk|clear-disk|bcdedit\s+\/(delete|deletevalue))\b/i)
  },
  {
    reason: 'BIOS/firmware settings change',
    test: rx(/\b(bios|uefi)\b.*\b(set|change|configure|write)\b|\bsetup_var\b|\bbcfg\b|\bmodifybios\b/i)
  },
  {
    reason: 'BitLocker key entry or management',
    test: rx(/\bmanage-bde\b|\bbitlocker\b|\b(unlock|enable|disable)-bitlocker\b|recovery\s*key/i)
  },
  {
    reason: 'Registry deletion',
    test: rx(/\breg\b\s+delete\b|\bremove-item\b[^\n]*\bhk(lm|cu|cr|u|cc)\b|\bremove-item\b[^\n]*registry::|\bremove-itemproperty\b[^\n]*hk/i)
  },
  {
    reason: 'Disables a security service or Microsoft Defender',
    test: rx(/\bset-mppreference\b[^\n]*disable|\bdisable\b[^\n]*(defender|windefend|wscsvc|securityhealthservice|sense|mpssvc)|\bstop-service\b[^\n]*(windefend|wscsvc|mpssvc|sense)|\bsc\b\s+(config|stop)\b[^\n]*(windefend|wscsvc|mpssvc)/i)
  }
]

/**
 * Remove-Item -Recurse is only a hit when it targets a non-temp path. This is a
 * separate rule so temp cleanup (a legitimate disk-space fix) isn't blocked.
 */
function removeRecurseOutsideTemp(detail: string): boolean {
  const isRecurse = /\bremove-item\b/i.test(detail) && /-recurse\b/i.test(detail)
  if (!isRecurse) return false
  return !TEMP_PATH.test(detail)
}

/**
 * Evaluate whether an action's detail should be forced to approval.
 * `kind` lets us skip evaluation for kinds that can never be destructive
 * (e.g. taking a screenshot), keeping the common path cheap.
 */
export function evaluateBlocklist(kind: ProposedActionKind, detail: string): BlocklistHit {
  if (kind === 'local_screenshot' || kind === 'wait' || kind === 'note' || kind === 'kvm_move') {
    return { blocked: false }
  }
  const text = detail ?? ''
  for (const rule of RULES) {
    if (rule.test(text)) return { blocked: true, reason: rule.reason }
  }
  if (removeRecurseOutsideTemp(text)) {
    return { blocked: true, reason: 'Recursive delete outside a temp path' }
  }
  return { blocked: false }
}

/** Exposed for tests. */
export const __rules = RULES

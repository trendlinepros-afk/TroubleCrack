/**
 * Session summary renderer. Turns a SessionSnapshot into a human-readable
 * Markdown report of the steps taken — usable mid-session (progress so far) or at
 * the end (final record) for pasting into a ticket / handing off. Pure and
 * dependency-free (types only) so it renders identically in main and in tests.
 */
import type { AttemptOutcome, SessionSnapshot } from './types'

export interface SummaryOptions {
  /** Reference time for "in progress" durations and the export stamp. */
  now?: number
  appVersion?: string
}

/** Render the full Markdown summary for a session snapshot. */
export function buildSessionSummary(s: SessionSnapshot, opts: SummaryOptions = {}): string {
  const now = opts.now ?? Date.now()
  const endTs = s.endedAt ?? now
  const durationMs = Math.max(0, endTs - s.startedAt)
  const out: string[] = []

  out.push('# TroubleCrack repair summary', '')
  out.push(`- **Machine:** ${s.machineDescriptor || 'unknown'}`)
  out.push(`- **Problem:** ${s.problemDescription || '(not described)'}`)
  out.push(`- **Target:** ${s.mode === 'local' ? 'This computer (Local mode)' : 'JetKVM device'}`)
  out.push(`- **Status:** ${statusLabel(s)}`)
  out.push(`- **Started:** ${fmtDateTime(s.startedAt)}`)
  out.push(`- **Duration:** ${fmtDuration(durationMs)}${s.endedAt ? '' : ' (in progress)'}`)
  out.push(`- **Steps attempted:** ${attemptsSummary(s)}`)
  out.push(`- **Approval mode:** ${s.approvalMode === 'auto' ? 'Auto (blocklist still confirms risky actions)' : 'Approval (each action confirmed)'}`)
  out.push(
    `- **Estimated API cost:** ${fmtUsd(s.cost.usd)} ` +
      `(${s.cost.inputTokens.toLocaleString()} in / ${s.cost.outputTokens.toLocaleString()} out tokens)`
  )
  const stamp = [`Exported ${fmtDateTime(now)}`]
  if (opts.appVersion) stamp.push(`TroubleCrack v${opts.appVersion}`)
  out.push(`- _${stamp.join(' · ')}_`)
  out.push('')

  // Steps taken (the attempt history — the heart of the report).
  out.push('## Steps taken', '')
  if (s.attempts.length === 0) {
    out.push('_No steps recorded yet._', '')
  } else {
    s.attempts.forEach((a, i) => {
      const end = a.endedAt ?? now
      const dur = fmtDuration(Math.max(0, end - a.startedAt))
      out.push(`### ${i + 1}. ${a.stepName}`)
      out.push(`${outcomeIcon(a.outcome)} **${outcomeLabel(a.outcome)}** · ${dur}${a.endedAt ? '' : ' · running'}`)
      if (a.detail) out.push('', a.detail.trim())
      if (a.actions.length) {
        out.push('')
        for (const act of a.actions) out.push(`- ${oneLine(act)}`)
      }
      out.push('')
    })
  }

  // Full activity log (the agent's narration).
  if (s.narration.length) {
    out.push('## Full activity log', '')
    for (const n of s.narration) out.push(`- \`${fmtClock(n.ts)}\` **${n.kind}** — ${oneLine(n.text)}`)
    out.push('')
  }

  // Administrator chat.
  if (s.chat.length) {
    out.push('## Administrator chat', '')
    for (const m of s.chat) {
      out.push(`- \`${fmtClock(m.ts)}\` **${m.role === 'admin' ? 'Admin' : 'Agent'}:** ${oneLine(m.text)}`)
    }
    out.push('')
  }

  if (s.lastError) out.push('## Last error', '', oneLine(s.lastError), '')

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** A filesystem-safe default filename for the exported summary. */
export function summaryFileName(s: SessionSnapshot): string {
  const d = new Date(s.startedAt)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const machine = slug(s.machineDescriptor || 'session')
  return `TroubleCrack ${date} ${machine}.md`
}

// --- helpers ---------------------------------------------------------------

function statusLabel(s: SessionSnapshot): string {
  if (s.runState === 'running') {
    return s.pendingApproval ? 'Running — waiting for approval' : `Running (${s.orchestratorState})`
  }
  if (s.runState === 'paused') return 'Paused'
  if (s.runState === 'finished' || s.runState === 'stopped') {
    switch (s.orchestratorState) {
      case 'FIXED':
        return 'Fixed'
      case 'NEEDS_HUMAN':
        return 'Needs a human'
      case 'GAVE_UP':
        return 'Unresolved (gave up)'
      default:
        return s.runState === 'stopped' ? 'Stopped' : 'Ended'
    }
  }
  return s.orchestratorState
}

function attemptsSummary(s: SessionSnapshot): string {
  const n = s.attempts.length
  if (n === 0) return '0'
  const counts = new Map<AttemptOutcome, number>()
  for (const a of s.attempts) counts.set(a.outcome, (counts.get(a.outcome) ?? 0) + 1)
  const parts = [...counts.entries()].map(([o, c]) => `${c} ${outcomeLabel(o).toLowerCase()}`)
  return `${n} (${parts.join(', ')})`
}

function outcomeLabel(o: AttemptOutcome): string {
  switch (o) {
    case 'fixed':
      return 'Fixed'
    case 'no_change':
      return 'No change'
    case 'new_failure':
      return 'New failure'
    case 'in_progress':
      return 'In progress'
    case 'error':
      return 'Error'
    case 'skipped':
      return 'Skipped'
    default:
      return o
  }
}

function outcomeIcon(o: AttemptOutcome): string {
  switch (o) {
    case 'fixed':
      return '✅'
    case 'no_change':
      return '❌'
    case 'new_failure':
      return '⚠️'
    case 'error':
      return '🛑'
    case 'skipped':
      return '➖'
    default:
      return '⏳'
  }
}

function oneLine(t: string): string {
  return t.replace(/\s+/g, ' ').trim()
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(v < 1 ? 3 : 2)}`
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function slug(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'session'
}

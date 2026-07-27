export function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function fmtUsd(v: number): string {
  return `$${v.toFixed(v < 1 ? 3 : 2)}`
}

export function outcomeIcon(outcome: string): string {
  switch (outcome) {
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

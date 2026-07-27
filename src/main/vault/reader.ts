import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VAULT_SUBDIR } from '@shared/constants'
import { createLogger } from '../logger'

const logger = createLogger('vault-reader')

export interface LessonMatch {
  file: string
  score: number
  excerpt: string
}

/** Tokenize a query into lowercased terms for simple full-text matching. */
export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3)
    )
  )
}

/** Score a note body against query terms (term frequency, capped per term). */
export function scoreNote(body: string, terms: string[], tags: string[]): number {
  const lower = body.toLowerCase()
  let score = 0
  for (const term of terms) {
    let count = 0
    let idx = lower.indexOf(term)
    while (idx !== -1 && count < 5) {
      count += 1
      idx = lower.indexOf(term, idx + term.length)
    }
    score += count
  }
  // Tag matches are worth more.
  for (const tag of tags) {
    if (lower.includes(tag.toLowerCase())) score += 3
  }
  return score
}

function firstLines(body: string, maxChars = 700): string {
  // Strip frontmatter for the excerpt.
  const withoutFm = body.replace(/^---[\s\S]*?---\n/, '').trim()
  return withoutFm.length > maxChars ? withoutFm.slice(0, maxChars) + '…' : withoutFm
}

/**
 * Search the vault's TroubleCrack/ folder for notes matching the current
 * symptoms/stop code and return the top matches. Fully defensive: a missing or
 * unreadable vault yields an empty list, never an error.
 */
export async function findLessons(
  vaultPath: string | null,
  query: string,
  tags: string[],
  top = 3
): Promise<LessonMatch[]> {
  if (!vaultPath) return []
  const dir = path.join(vaultPath, VAULT_SUBDIR)
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const terms = tokenize(query + ' ' + tags.join(' '))
  const matches: LessonMatch[] = []
  for (const f of files) {
    try {
      const body = await fs.readFile(path.join(dir, f), 'utf8')
      const score = scoreNote(body, terms, tags)
      if (score > 0) matches.push({ file: f, score, excerpt: firstLines(body) })
    } catch (err) {
      logger.warn(`Could not read vault note ${f}`)
    }
  }
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, top)
}

/** Format matches into a text block for the agent's initial context. */
export function formatLessons(matches: LessonMatch[]): string {
  if (matches.length === 0) return ''
  return matches
    .map((m, i) => `Lesson ${i + 1} (from ${m.file}):\n${m.excerpt}`)
    .join('\n\n')
}

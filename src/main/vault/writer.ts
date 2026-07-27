import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VAULT_SUBDIR } from '@shared/constants'
import type { TargetMode } from '@shared/types'
import { createLogger } from '../logger'

const logger = createLogger('vault-writer')

export interface VaultNoteInput {
  /** YYYY-MM-DD */
  date: string
  mode: TargetMode
  machineDescriptor: string
  symptomTags: string[]
  stopCode: string | null
  outcome: string
  slug: string
  symptoms: string
  whatWorked: string
  whatDidntWork: string[]
  notesForNextTime: string
}

/** Slugify a short label into a filesystem-safe fragment. */
export function slugify(input: string, fallback = 'repair'): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || fallback
}

export function noteFilename(date: string, slug: string): string {
  return `${date} ${slugify(slug)}.md`
}

function yamlList(items: string[]): string {
  if (items.length === 0) return '[]'
  return '\n' + items.map((t) => `  - ${escapeYaml(t)}`).join('\n')
}

function escapeYaml(v: string): string {
  // Only quote when a bare scalar would actually be misparsed: an empty string,
  // a leading indicator character, or a value containing ": ", " #", a quote, or
  // a newline. A mid-word hyphen (e.g. "no-boot") is fine unquoted.
  if (v === '') return '""'
  if (/^[\s#&*!|>%@`"'\[\]{},]/.test(v)) return JSON.stringify(v)
  if (/^[-?:]\s/.test(v)) return JSON.stringify(v)
  if (/:\s|\s#|["\n]/.test(v)) return JSON.stringify(v)
  return v
}

/**
 * Render a TroubleCrack markdown note. Pure — unit-tested. Written by Claude as
 * a summarization over the session log; this function just lays it out.
 */
export function renderNote(input: VaultNoteInput): string {
  const didnt =
    input.whatDidntWork.length > 0
      ? input.whatDidntWork.map((l) => `- ${l}`).join('\n')
      : '- (nothing recorded)'
  return `---
date: ${input.date}
mode: ${input.mode}
machine: ${escapeYaml(input.machineDescriptor || 'unknown')}
symptom_tags:${yamlList(input.symptomTags)}
stop_code: ${input.stopCode ? escapeYaml(input.stopCode) : 'null'}
outcome: ${input.outcome}
---

# ${input.date} — ${input.machineDescriptor || 'Repair'}

## Symptoms
${input.symptoms.trim() || '(not recorded)'}

## What worked
${input.whatWorked.trim() || 'Unresolved'}

## What didn't work
${didnt}

## Notes for next time
${input.notesForNextTime.trim() || '(none)'}
`
}

/**
 * Persist a note into <vault>/TroubleCrack/. Returns the path, or null on any
 * failure — vault I/O is defensive and never blocks or fails a repair.
 */
export async function writeNote(vaultPath: string, input: VaultNoteInput): Promise<string | null> {
  try {
    const dir = path.join(vaultPath, VAULT_SUBDIR)
    await fs.mkdir(dir, { recursive: true })
    let file = path.join(dir, noteFilename(input.date, input.slug))
    // Avoid clobbering an existing note from the same day/slug.
    let n = 1
    while (await exists(file)) {
      file = path.join(dir, noteFilename(input.date, `${input.slug}-${n}`))
      n += 1
    }
    await fs.writeFile(file, renderNote(input), 'utf8')
    logger.info(`Wrote vault note: ${file}`)
    return file
  } catch (err) {
    logger.error('Failed to write vault note (continuing without it)', err)
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

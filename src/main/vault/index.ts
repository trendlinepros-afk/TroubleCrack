import { findLessons, formatLessons } from './reader'
import { writeNote, type VaultNoteInput } from './writer'

export * from './writer'
export * from './reader'

/** Thin facade the session uses; carries the configured vault path (or null). */
export class VaultService {
  constructor(private vaultPath: string | null) {}

  isEnabled(): boolean {
    return this.vaultPath !== null && this.vaultPath.trim() !== ''
  }

  async lessonsText(query: string, tags: string[]): Promise<string> {
    const matches = await findLessons(this.vaultPath, query, tags)
    return formatLessons(matches)
  }

  async write(input: VaultNoteInput): Promise<string | null> {
    if (!this.isEnabled()) return null
    return writeNote(this.vaultPath as string, input)
  }
}

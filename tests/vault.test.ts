import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderNote, slugify, noteFilename, writeNote, type VaultNoteInput } from '../src/main/vault/writer'
import { tokenize, scoreNote, findLessons } from '../src/main/vault/reader'

const baseNote: VaultNoteInput = {
  date: '2026-07-27',
  mode: 'kvm',
  machineDescriptor: 'Dell OptiPlex 7080',
  symptomTags: ['no-boot', 'bsod'],
  stopCode: 'INACCESSIBLE_BOOT_DEVICE',
  outcome: 'FIXED',
  slug: 'inaccessible-boot-device',
  symptoms: 'BSOD 0x7B on boot.',
  whatWorked: 'bootrec /rebuildbcd then bcdboot.',
  whatDidntWork: ['Startup Repair', 'chkdsk'],
  notesForNextTime: 'Check SATA mode (AHCI vs RAID) in BIOS.'
}

describe('vault writer (pure)', () => {
  it('slugifies safely', () => {
    expect(slugify('BSOD 0x7B / no boot!')).toBe('bsod-0x7b-no-boot')
    expect(slugify('')).toBe('repair')
    expect(slugify('   ---   ')).toBe('repair')
  })

  it('builds the filename with date and slug', () => {
    expect(noteFilename('2026-07-27', 'my slug')).toBe('2026-07-27 my-slug.md')
  })

  it('renders frontmatter and all sections', () => {
    const md = renderNote(baseNote)
    expect(md).toContain('date: 2026-07-27')
    expect(md).toContain('mode: kvm')
    expect(md).toContain('outcome: FIXED')
    expect(md).toContain('stop_code: ')
    expect(md).toContain('- no-boot')
    expect(md).toContain('## Symptoms')
    expect(md).toContain('## What worked')
    expect(md).toContain('## What didn\'t work')
    expect(md).toContain('- Startup Repair')
    expect(md).toContain('## Notes for next time')
  })

  it('shows Unresolved when nothing worked', () => {
    const md = renderNote({ ...baseNote, whatWorked: '' })
    expect(md).toContain('Unresolved')
  })
})

describe('vault writer (disk)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-vault-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes a note into TroubleCrack/ and returns the path', async () => {
    const file = await writeNote(dir, baseNote)
    expect(file).not.toBeNull()
    expect(file!).toContain(path.join('TroubleCrack', '2026-07-27 inaccessible-boot-device.md'))
    const content = await fs.readFile(file!, 'utf8')
    expect(content).toContain('bootrec /rebuildbcd')
  })

  it('does not clobber an existing note of the same day/slug', async () => {
    const a = await writeNote(dir, baseNote)
    const b = await writeNote(dir, baseNote)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('returns null (never throws) on an unwritable path', async () => {
    const file = await writeNote('/this/does/not/exist/and-cannot-be-made\0bad', baseNote)
    expect(file).toBeNull()
  })
})

describe('vault reader', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-read-'))
    await writeNote(dir, baseNote)
    await writeNote(dir, {
      ...baseNote,
      slug: 'vpn-fix',
      symptomTags: ['network', 'vpn'],
      symptoms: 'VPN would not connect after update.',
      whatWorked: 'Reset Winsock.',
      stopCode: null
    })
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('tokenizes, keeping meaningful 3-letter terms and dropping shorter ones', () => {
    const t = tokenize('to a VPN via DNS')
    expect(t).toContain('vpn')
    expect(t).toContain('dns')
    expect(t).not.toContain('to')
    expect(t).not.toContain('a')
  })

  it('scores tag matches higher', () => {
    const body = 'symptom_tags:\n  - network\n  - vpn\nVPN failure'
    expect(scoreNote(body, ['vpn'], ['network'])).toBeGreaterThan(scoreNote(body, ['vpn'], []))
  })

  it('finds the relevant note by symptom', async () => {
    const matches = await findLessons(dir, 'vpn wont connect', ['vpn', 'network'])
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.file).toContain('vpn-fix')
  })

  it('returns [] for a missing vault, never throwing', async () => {
    const matches = await findLessons('/nope/not/here', 'anything', ['x'])
    expect(matches).toEqual([])
  })

  it('returns [] when vaultPath is null', async () => {
    expect(await findLessons(null, 'x', [])).toEqual([])
  })
})

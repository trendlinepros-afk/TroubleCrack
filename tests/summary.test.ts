import { describe, it, expect } from 'vitest'
import { buildSessionSummary, summaryFileName } from '../src/shared/summary'
import type { SessionSnapshot } from '../src/shared/types'

const NOW = 1_700_000_000_000

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'sess-1',
    mode: 'kvm',
    machineDescriptor: 'Dell OptiPlex 7080',
    problemDescription: "won't boot",
    approvalMode: 'approval',
    runState: 'finished',
    orchestratorState: 'FIXED',
    playbookId: 'no-boot-windows',
    currentStepId: null,
    currentStepName: null,
    attempts: [],
    narration: [],
    chat: [],
    cost: { inputTokens: 12000, outputTokens: 3400, usd: 0.145 },
    startedAt: NOW - 125_000,
    updatedAt: NOW,
    endedAt: NOW - 3_000,
    manualControl: false,
    pendingApproval: null,
    failedStepIds: [],
    iterations: 7,
    lastError: null,
    ...over
  }
}

describe('buildSessionSummary', () => {
  const full = snapshot({
    attempts: [
      {
        id: 'a1',
        stepId: 's1',
        stepName: 'Boot into Safe Mode',
        actions: ['Pressed F8 at power-on', 'Selected Safe Mode with Networking'],
        outcome: 'fixed',
        startedAt: NOW - 125_000,
        endedAt: NOW - 60_000,
        detail: 'Reached the safe-mode desktop'
      },
      {
        id: 'a2',
        stepId: 's2',
        stepName: 'Run SFC',
        actions: ['Ran sfc /scannow'],
        outcome: 'no_change',
        startedAt: NOW - 60_000,
        endedAt: NOW - 3_000
      }
    ],
    narration: [{ id: 'n1', ts: NOW - 120_000, kind: 'plan', text: 'Try safe mode\nthen SFC' }],
    chat: [{ id: 'c1', ts: NOW - 118_000, role: 'admin', text: 'The BIOS is\nset to UEFI' }]
  })

  it('renders a header with machine, problem, status and cost', () => {
    const md = buildSessionSummary(full, { now: NOW, appVersion: '1.2.3' })
    expect(md).toContain('# TroubleCrack repair summary')
    expect(md).toContain('Dell OptiPlex 7080')
    expect(md).toContain("won't boot")
    expect(md).toContain('**Status:** Fixed')
    expect(md).toContain('$0.145')
    expect(md).toContain('TroubleCrack v1.2.3')
    expect(md).toContain('**Steps attempted:** 2 (1 fixed, 1 no change)')
  })

  it('lists each step with its outcome and actions', () => {
    const md = buildSessionSummary(full, { now: NOW })
    expect(md).toContain('### 1. Boot into Safe Mode')
    expect(md).toContain('✅ **Fixed**')
    expect(md).toContain('- Pressed F8 at power-on')
    expect(md).toContain('Reached the safe-mode desktop')
    expect(md).toContain('### 2. Run SFC')
    expect(md).toContain('❌ **No change**')
  })

  it('includes the activity log and admin chat, collapsing multi-line text', () => {
    const md = buildSessionSummary(full, { now: NOW })
    expect(md).toContain('## Full activity log')
    expect(md).toContain('Try safe mode then SFC')
    expect(md).toContain('## Administrator chat')
    expect(md).toContain('**Admin:** The BIOS is set to UEFI')
  })

  it('marks an in-progress session and running steps', () => {
    const md = buildSessionSummary(
      snapshot({
        runState: 'running',
        orchestratorState: 'EXECUTING_STEP',
        endedAt: null,
        attempts: [
          {
            id: 'a1',
            stepId: 's1',
            stepName: 'Check disk',
            actions: ['chkdsk C:'],
            outcome: 'in_progress',
            startedAt: NOW - 20_000,
            endedAt: null
          }
        ]
      }),
      { now: NOW }
    )
    expect(md).toContain('(in progress)')
    expect(md).toContain('Running (EXECUTING_STEP)')
    expect(md).toContain('· running')
  })

  it('handles a session with no steps yet', () => {
    const md = buildSessionSummary(snapshot({ attempts: [] }), { now: NOW })
    expect(md).toContain('_No steps recorded yet._')
  })

  it('always ends with a single trailing newline', () => {
    const md = buildSessionSummary(full, { now: NOW })
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })
})

describe('summaryFileName', () => {
  it('builds a dated, slugged .md filename', () => {
    const name = summaryFileName(snapshot({ machineDescriptor: 'Dell OptiPlex 7080' }))
    expect(name.startsWith('TroubleCrack ')).toBe(true)
    expect(name.endsWith('.md')).toBe(true)
    expect(name).toContain('dell-optiplex-7080')
  })

  it('falls back to "session" when the machine is blank', () => {
    expect(summaryFileName(snapshot({ machineDescriptor: '' }))).toContain('session')
  })
})

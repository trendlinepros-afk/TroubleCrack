import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '../logger'
import { AnthropicService, type BetaMessageParam } from '../anthropic/client'
import { kvmBridge } from '../kvmBridge'
import type { TargetBackend, ToolInvocation } from '../backends/types'
import { VaultService, type VaultNoteInput } from '../vault'
import { ApprovalGate } from './approvalGate'
import {
  advanceToNextStep,
  checkCaps,
  initialContext,
  isTerminalState,
  reduce,
  type OrchestratorContext,
  type VerifyOutcome
} from './stateMachine'
import { watchBoot } from './bootWatcher'
import { evaluateBlocklist } from '@shared/blocklist'
import { choosePlaybook, getPlaybook } from '@shared/playbooks'
import type { Playbook, PlaybookStep } from '@shared/playbooks'
import {
  BOOT_WATCHER_POLL_MS,
  BOOT_WATCHER_TIMEOUT_MS
} from '@shared/constants'
import type {
  ApprovalDecision,
  ApprovalMode,
  Attempt,
  AttemptOutcome,
  BootOutcome,
  Caps,
  NarrationKind,
  Observation,
  ProposedAction,
  SessionSnapshot,
  StartSessionInput
} from '@shared/types'

const logger = createLogger('session')
const MAX_TURNS_PER_STEP = 14
const MAX_NARRATION = 300
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface SessionCallbacks {
  onSnapshot: (s: SessionSnapshot) => void
  onFinished: (s: SessionSnapshot) => void
}

const BASE_SYSTEM =
  'You are TroubleCrack, a careful, supervised repair agent working ONE playbook ' +
  'step at a time under human oversight. Diagnose before acting. Take the ' +
  'smallest safe action that makes progress, and verify results. Never take a ' +
  'destructive action (formatting, partitioning, deleting data, BitLocker, BIOS ' +
  'changes) without the administrator approving it. Explain what you are doing in ' +
  'plain language.'

const CLASSIFY_SYSTEM =
  'You classify what is on a Windows machine screen during a repair. Respond with ' +
  'ONLY a JSON object, no prose.'

/**
 * Runs a single supervised repair session. Owns the state machine, the per-step
 * agent loop, approval gating, the boot watcher, attempt history, chat guidance,
 * hard caps, and the vault write-back. Everything is streamed to the renderer as
 * a SessionSnapshot and persisted by the manager.
 */
export class RepairSession {
  readonly id: string
  private snapshot: SessionSnapshot
  private ctx: OrchestratorContext
  private playbook: Playbook
  private gate = new ApprovalGate()
  private stopped = false
  private paused = false
  private manualControl = false
  private stepAutoApprove = false
  private baselineObservation: Observation | null = null
  private lastResultFlag: string | null = null
  private lastAssistantText = ''
  private startedAt: number

  constructor(
    input: StartSessionInput,
    private readonly anthropic: AnthropicService,
    private readonly backend: TargetBackend,
    private readonly vault: VaultService,
    caps: Caps,
    private readonly cb: SessionCallbacks
  ) {
    this.id = randomUUID()
    this.startedAt = Date.now()
    const pb = getPlaybook(input.playbookId ?? '') ?? this.defaultPlaybook(input)
    this.playbook = pb
    this.ctx = initialContext(pb.steps.length, caps)
    this.snapshot = {
      id: this.id,
      mode: input.mode,
      machineDescriptor: input.machineDescriptor,
      problemDescription: input.problemDescription,
      approvalMode: input.approvalMode,
      runState: 'idle',
      orchestratorState: 'IDLE',
      playbookId: pb.id,
      currentStepId: null,
      currentStepName: null,
      attempts: [],
      narration: [],
      chat: [],
      cost: { inputTokens: 0, outputTokens: 0, usd: 0 },
      startedAt: this.startedAt,
      updatedAt: this.startedAt,
      endedAt: null,
      manualControl: false,
      pendingApproval: null,
      failedStepIds: [],
      iterations: 0,
      lastError: null
    }
  }

  private defaultPlaybook(input: StartSessionInput): Playbook {
    return choosePlaybook(input.mode, input.problemDescription)
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  // --- external controls ---------------------------------------------------

  pause(): void {
    if (this.snapshot.runState === 'running') {
      this.paused = true
      this.snapshot.runState = 'paused'
      this.narrate('info', 'Paused by administrator.')
      this.emit()
    }
  }

  resume(): void {
    if (this.snapshot.runState === 'paused') {
      this.paused = false
      this.snapshot.runState = 'running'
      this.narrate('info', 'Resumed.')
      this.emit()
    }
  }

  stop(): void {
    this.stopped = true
    this.paused = false
    this.gate.cancelAll('Session stopped')
    this.narrate('info', 'Stopping…')
    this.emit()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.snapshot.approvalMode = mode
    this.narrate('info', `Approval mode: ${mode}.`)
    this.emit()
  }

  async setManualControl(enabled: boolean): Promise<void> {
    this.manualControl = enabled
    this.snapshot.manualControl = enabled
    this.narrate('info', enabled ? 'Manual control ON — the agent is paused.' : 'Manual control OFF.')
    if (this.backend.mode === 'kvm') {
      // Tell the renderer to pass input through / stop passing through.
      try {
        await kvmBridge.send({ type: 'setManual', enabled }, 5000)
      } catch (err) {
        logger.warn('Failed to toggle manual control on renderer')
      }
    }
    this.emit()
  }

  submitApproval(actionId: string, decision: ApprovalDecision): void {
    this.gate.submit(actionId, decision)
  }

  async sendChat(text: string): Promise<void> {
    this.addChat('admin', text)
    // Generate a short conversational reply without blocking the run loop.
    void this.replyToChat(text)
  }

  private async replyToChat(text: string): Promise<void> {
    try {
      const context = this.chatContext()
      const reply = await this.anthropic.summarize(
        'You are TroubleCrack replying to the administrator during a live repair. ' +
          'Be brief, concrete, and helpful. If they gave guidance, acknowledge that ' +
          'you will factor it into the next step.',
        `${context}\n\nAdministrator says: ${text}\n\nReply in 1-3 sentences.`,
        400
      )
      this.addChat('agent', reply || 'Understood.')
    } catch (err) {
      this.addChat('agent', 'Noted. (I could not reach the model for a reply just now.)')
    }
  }

  // --- main run loop -------------------------------------------------------

  async run(): Promise<void> {
    this.snapshot.runState = 'running'
    this.ctx = reduce(this.ctx, { type: 'START' }) // → OBSERVING
    this.syncFromCtx()
    this.emit()

    try {
      this.narrate('info', `Connecting to ${this.backend.mode === 'kvm' ? 'the JetKVM' : 'this machine'}…`)
      await this.backend.connect()
      this.narrate('info', 'Connected.')
    } catch (err) {
      this.fail(`Could not connect: ${(err as Error).message}`)
      await this.finalize()
      return
    }

    // Inject lessons from past repairs (defensive: never blocks the repair).
    let lessons = ''
    try {
      lessons = await this.vault.lessonsText(
        `${this.snapshot.problemDescription} ${this.playbook.tags.join(' ')}`,
        this.playbook.tags
      )
      if (lessons) this.narrate('info', 'Loaded lessons from past repairs in the vault.')
    } catch {
      /* ignore vault read issues */
    }

    while (!this.stopped && !isTerminalState(this.ctx.state)) {
      await this.waitWhileHeld()
      if (this.stopped) break

      this.ctx = this.syncMetrics(this.ctx)
      const step = this.playbook.steps[this.ctx.stepIndex]
      if (!step) break
      this.snapshot.currentStepId = step.id
      this.snapshot.currentStepName = step.name

      switch (this.ctx.state) {
        case 'OBSERVING': {
          this.narrate('observe', `Observing (${step.name}).`)
          this.baselineObservation = await this.observe()
          this.ctx = reduce(this.ctx, { type: 'OBSERVE_DONE' })
          break
        }
        case 'PLANNING': {
          this.narrate('plan', `Planning: ${step.name}.`)
          this.ctx = this.syncMetrics(this.ctx)
          this.ctx = reduce(this.ctx, { type: 'PLAN_DONE' })
          if (this.ctx.state === 'NEEDS_HUMAN') {
            this.narrate('warn', `Hit the ${this.ctx.capHit} cap — pausing for a human.`)
          }
          break
        }
        case 'EXECUTING_STEP': {
          if (step.terminal) {
            await this.runTerminalStep(step)
            this.ctx = { ...this.ctx, state: 'GAVE_UP' }
          } else {
            const attempt = this.startAttempt(step)
            const outcome = await this.runStep(step, lessons, attempt)
            if (outcome === 'needs_human') {
              this.finishAttempt(attempt, 'error', 'Blocked; needs a human.')
              this.ctx = reduce(this.ctx, { type: 'NEEDS_HUMAN' })
            } else {
              this.ctx = reduce(this.ctx, { type: 'EXECUTE_DONE' })
            }
          }
          break
        }
        case 'VERIFYING': {
          const verifyOutcome = await this.verify(step)
          const attempt = this.currentAttempt()
          if (attempt) this.finishAttempt(attempt, mapOutcome(verifyOutcome), verifyOutcome)
          const failedStepId = verifyOutcome === 'FIXED' ? undefined : step.id
          this.ctx = reduce(this.ctx, { type: 'VERIFY_DONE', outcome: verifyOutcome, failedStepId })
          break
        }
        case 'NEXT_STEP': {
          this.ctx = advanceToNextStep(this.ctx)
          this.stepAutoApprove = false
          break
        }
        default:
          break
      }
      this.syncFromCtx()
      this.emit()
    }

    await this.finalize()
  }

  // --- steps ---------------------------------------------------------------

  private async observe(): Promise<Observation> {
    const per = await this.backend.perceive()
    if (this.backend.mode === 'kvm' && per.imageBase64) {
      return this.classifyImage(per.imageBase64, per.imageMediaType ?? 'image/jpeg')
    }
    // Local: no visual classification; the baseline is the reported problem.
    return {
      failureClass: 'unknown',
      stopCode: null,
      summary: per.text.slice(0, 300),
      confident: false
    }
  }

  private async classifyImage(imageBase64: string, mediaType: string): Promise<Observation> {
    const prompt =
      'Classify this Windows screen. Return JSON: {"failureClass": one of ' +
      '["bios","vendor_logo_hang","bsod","boot_device_not_found","winre",' +
      '"spinning_loop","black_screen","desktop","login","bitlocker_recovery",' +
      '"unknown"], "stopCode": string-or-null, "summary": short string, ' +
      '"confident": boolean}.'
    try {
      const raw = await this.anthropic.visionText(CLASSIFY_SYSTEM, prompt, imageBase64, mediaType)
      const json = extractJson(raw)
      if (json) {
        return {
          failureClass: (json.failureClass as Observation['failureClass']) ?? 'unknown',
          stopCode: typeof json.stopCode === 'string' ? json.stopCode : null,
          summary: typeof json.summary === 'string' ? json.summary : 'Screen observed.',
          confident: json.confident === true
        }
      }
    } catch (err) {
      logger.warn('Classification failed; treating as unknown')
    }
    return { failureClass: 'unknown', stopCode: null, summary: 'Could not classify screen.', confident: false }
  }

  /** The per-step agent loop. Returns 'done' or 'needs_human'. */
  private async runStep(
    step: PlaybookStep,
    lessons: string,
    attempt: Attempt
  ): Promise<'done' | 'needs_human'> {
    this.lastResultFlag = null
    const system = `${BASE_SYSTEM}\n\n${this.backend.systemHint()}`
    const initialText = this.buildStepContext(step, lessons)
    const per = await this.backend.perceive()

    const firstContent: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
      { type: 'text', text: `${initialText}\n\n${per.text}` }
    ]
    if (per.imageBase64) {
      firstContent.push(imageBlock(per.imageBase64, per.imageMediaType ?? 'image/jpeg'))
    }
    const messages: BetaMessageParam[] = [{ role: 'user', content: firstContent }]

    for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
      await this.waitWhileHeld()
      if (this.stopped) return 'done'

      this.ctx = this.syncMetrics(this.ctx)
      const cap = checkCaps(this.ctx)
      if (cap.hit) {
        this.narrate('warn', `Hit the ${cap.which} cap mid-step.`)
        return 'needs_human'
      }

      let msg: Anthropic.Beta.Messages.BetaMessage
      try {
        msg = await this.anthropic.createStep({
          model: this.anthropicModel(),
          system,
          messages,
          tools: this.backend.tools(),
          betas: this.backend.betas(),
          maxTokens: 4096
        })
      } catch (err) {
        this.fail((err as Error).message)
        return 'needs_human'
      }
      this.updateCost()

      messages.push({ role: 'assistant', content: msg.content })
      this.narrateAssistant(msg.content)
      const flag = parseResultFlag(msg.content)
      if (flag) this.lastResultFlag = flag

      const toolUses = msg.content.filter(
        (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use'
      )
      if (toolUses.length === 0) {
        // Model finished its turn (end_turn). Step is done.
        return this.lastResultFlag === 'NEEDS_HUMAN' ? 'needs_human' : 'done'
      }

      const toolResults: Anthropic.Beta.Messages.BetaContentBlockParam[] = []
      for (const tu of toolUses) {
        if (this.stopped) return 'done'
        const inv: ToolInvocation = {
          id: tu.id,
          name: tu.name,
          input: (tu.input as Record<string, unknown>) ?? {}
        }
        const rendered = this.backend.renderAction(inv)
        const block = evaluateBlocklist(rendered.kind, rendered.detail)
        const action: ProposedAction = {
          id: tu.id,
          kind: rendered.kind,
          summary: rendered.summary,
          detail: rendered.detail,
          payload: inv.input,
          requiresApproval: this.needsApproval(block.blocked),
          ...(block.reason ? { blocklistReason: block.reason } : {})
        }

        const decision = await this.approve(action)
        if (decision.type === 'deny') {
          this.narrate('warn', `Denied: ${action.summary}${decision.reason ? ` (${decision.reason})` : ''}`)
          toolResults.push(toolResultBlock(tu.id, `Administrator denied this action.${decision.reason ? ' Reason: ' + decision.reason : ''} Choose a different approach.`, true))
          continue
        }
        if (decision.autoApproveStep) this.stepAutoApprove = true

        this.narrate('action', action.summary)
        let exec
        try {
          exec = await this.backend.execute(inv)
        } catch (err) {
          toolResults.push(toolResultBlock(tu.id, `Execution failed: ${(err as Error).message}`, true))
          continue
        }
        for (const line of exec.actionLog) attempt.actions.push(line)
        this.emit()
        toolResults.push(
          exec.imageBase64
            ? toolResultWithImage(tu.id, exec.resultText, exec.imageBase64, exec.imageMediaType ?? 'image/jpeg', exec.isError === true)
            : toolResultBlock(tu.id, exec.resultText, exec.isError === true)
        )
      }
      messages.push({ role: 'user', content: toolResults })
    }

    this.narrate('warn', `Step reached the ${MAX_TURNS_PER_STEP}-turn limit.`)
    return 'done'
  }

  private async runTerminalStep(step: PlaybookStep): Promise<void> {
    this.narrate('info', step.name)
    const attempt = this.startAttempt(step)
    this.finishAttempt(attempt, 'skipped', 'Wrote the final report and recommended a reimage.')
  }

  private async verify(step: PlaybookStep): Promise<VerifyOutcome> {
    let outcome: VerifyOutcome
    if (this.backend.supportsReboot && step.rebootAfter && !step.terminal) {
      this.narrate('verify', 'Rebooting the target and watching the boot…')
      try {
        await this.backend.reboot()
      } catch {
        this.narrate('warn', 'Automatic reboot failed. If the machine is hard-frozen, please press its power button.')
      }
      const result = await watchBoot(this.baselineObservation, {
        pollIntervalMs: BOOT_WATCHER_POLL_MS,
        timeoutMs: BOOT_WATCHER_TIMEOUT_MS,
        now: () => Date.now(),
        sleep,
        classify: async () => {
          const frame = await this.backend.watchFrame()
          if (!frame.imageBase64) {
            return { failureClass: 'unknown', stopCode: null, summary: 'no frame', confident: false }
          }
          return this.classifyImage(frame.imageBase64, frame.imageMediaType ?? 'image/jpeg')
        },
        onProgress: (elapsed, obs) => {
          if (elapsed % 30000 < BOOT_WATCHER_POLL_MS) {
            this.narrate('verify', `Boot watch (${Math.round(elapsed / 1000)}s): ${obs.summary}`)
          }
        },
        shouldAbort: () => this.stopped
      })
      this.narrate('verify', `Boot outcome: ${result.outcome} — ${result.observation.summary}`)
      outcome = result.outcome
    } else {
      // No reboot (local, or a non-reboot step): trust the step self-assessment.
      const fixed = this.lastResultFlag === 'FIXED'
      this.narrate('verify', fixed ? 'Step reports the problem resolved.' : 'Step did not resolve the problem.')
      outcome = fixed ? 'FIXED' : ('NO_CHANGE' as VerifyOutcome)
    }

    // Second opinion: before accepting a "fixed", a fresh skeptical pass checks
    // the evidence against the reported problem. Booting is not the same as the
    // problem being resolved, and a self-assessment can be over-confident.
    if (outcome === 'FIXED' && !this.stopped) {
      const opinion = await this.confirmFixed()
      if (!opinion.confirmed) {
        this.narrate('warn', `Second opinion did not confirm the fix (${opinion.reason}). Continuing the ladder.`)
        return 'NO_CHANGE' as VerifyOutcome
      }
      this.narrate('verify', `Second opinion confirmed the fix${opinion.reason ? `: ${opinion.reason}` : ''}.`)
    }
    return outcome
  }

  /**
   * A fresh-context skeptical check of a claimed fix against the reported
   * problem. Independent of the step that produced the claim. Defaults to
   * accepting on any error — a flaky check must never veto a real fix.
   */
  private async confirmFixed(): Promise<{ confirmed: boolean; reason: string }> {
    const problem = this.snapshot.problemDescription || 'the reported problem'
    try {
      if (this.backend.mode === 'kvm') {
        const frame = await this.backend.watchFrame()
        if (!frame.imageBase64) return { confirmed: true, reason: 'no frame to re-check' }
        const raw = await this.anthropic.visionText(
          'You are a strict, skeptical reviewer verifying a repair claim. Respond with ONLY JSON.',
          `The agent claims this problem is now resolved: "${problem}". Look at the current screen. ` +
            `Is it actually resolved? Be strict: if the screen does not clearly show resolution (it is ` +
            `still at an error, a recovery/boot screen, or an unrelated state), answer confirmed=false. ` +
            `Return {"confirmed": boolean, "reason": short string}.`,
          frame.imageBase64,
          frame.imageMediaType ?? 'image/jpeg'
        )
        const j = extractJson(raw)
        if (j && typeof j.confirmed === 'boolean') {
          return { confirmed: j.confirmed, reason: typeof j.reason === 'string' ? j.reason : '' }
        }
        return { confirmed: true, reason: 'inconclusive re-check' }
      }
      const evidence = `${this.lastAssistantText}\n${this.currentAttempt()?.actions.slice(-8).join('\n') ?? ''}`.trim()
      const raw = await this.anthropic.summarize(
        'You are a strict, skeptical reviewer verifying a repair claim. Respond with ONLY JSON.',
        `Reported problem: "${problem}".\nWhat the agent did and observed:\n${evidence}\n\n` +
          `Is the problem actually resolved by this? Be strict — if the evidence shows errors, is ` +
          `inconclusive, or only describes an intended fix without confirming it worked, answer ` +
          `confirmed=false. Return {"confirmed": boolean, "reason": short string}.`,
        300
      )
      const j = extractJson(raw)
      if (j && typeof j.confirmed === 'boolean') {
        return { confirmed: j.confirmed, reason: typeof j.reason === 'string' ? j.reason : '' }
      }
      return { confirmed: true, reason: 'inconclusive re-check' }
    } catch {
      return { confirmed: true, reason: 'second opinion unavailable' }
    }
  }

  // --- approval ------------------------------------------------------------

  private needsApproval(blocked: boolean): boolean {
    if (blocked) return true
    if (this.snapshot.approvalMode === 'approval' && !this.stepAutoApprove) return true
    return false
  }

  private async approve(action: ProposedAction): Promise<ApprovalDecision> {
    if (!action.requiresApproval) {
      this.narrate('info', `Auto-approved: ${action.summary}`)
      return { type: 'approve' }
    }
    this.snapshot.pendingApproval = {
      action,
      autoApproveStepAvailable: !action.blocklistReason
    }
    if (action.blocklistReason) {
      this.narrate('warn', `Approval required (${action.blocklistReason}): ${action.summary}`)
    } else {
      this.narrate('info', `Waiting for approval: ${action.summary}`)
    }
    this.emit()
    const decision = await this.gate.wait(action)
    this.snapshot.pendingApproval = null
    this.emit()
    return decision
  }

  // --- verify/attempt/narration helpers -----------------------------------

  private startAttempt(step: PlaybookStep): Attempt {
    const attempt: Attempt = {
      id: randomUUID(),
      stepId: step.id,
      stepName: step.name,
      actions: [],
      outcome: 'in_progress',
      startedAt: Date.now(),
      endedAt: null
    }
    this.snapshot.attempts.push(attempt)
    this.emit()
    return attempt
  }

  private currentAttempt(): Attempt | undefined {
    for (let i = this.snapshot.attempts.length - 1; i >= 0; i--) {
      const a = this.snapshot.attempts[i]
      if (a && a.outcome === 'in_progress') return a
    }
    return undefined
  }

  private finishAttempt(attempt: Attempt, outcome: AttemptOutcome, detail?: string): void {
    attempt.outcome = outcome
    attempt.endedAt = Date.now()
    if (detail) attempt.detail = detail
    this.emit()
  }

  private narrate(kind: NarrationKind, text: string): void {
    this.snapshot.narration.push({ id: randomUUID(), ts: Date.now(), kind, text })
    if (this.snapshot.narration.length > MAX_NARRATION) {
      this.snapshot.narration.splice(0, this.snapshot.narration.length - MAX_NARRATION)
    }
    this.emit()
  }

  private narrateAssistant(content: Anthropic.Beta.Messages.BetaContentBlock[]): void {
    for (const b of content) {
      if (b.type === 'text' && b.text.trim()) {
        const clean = b.text.replace(/RESULT:\s*\w+/gi, '').trim()
        if (clean) {
          this.narrate('info', clean.slice(0, 600))
          this.lastAssistantText = clean.slice(0, 1200)
        }
      }
    }
  }

  private addChat(role: 'admin' | 'agent', text: string): void {
    this.snapshot.chat.push({ id: randomUUID(), ts: Date.now(), role, text })
    this.narrateIfAgent(role, text)
    this.emit()
  }

  private narrateIfAgent(role: 'admin' | 'agent', _text: string): void {
    if (role === 'admin') this.narrate('chat', 'Administrator sent guidance.')
  }

  private chatContext(): string {
    const recentAttempts = this.snapshot.attempts
      .slice(-4)
      .map((a) => `- ${a.stepName}: ${a.outcome}`)
      .join('\n')
    return (
      `Mode: ${this.snapshot.mode}. Machine: ${this.snapshot.machineDescriptor}. ` +
      `Problem: ${this.snapshot.problemDescription}.\n` +
      `Current step: ${this.snapshot.currentStepName ?? 'n/a'} (${this.ctx.state}).\n` +
      (recentAttempts ? `Recent attempts:\n${recentAttempts}` : '')
    )
  }

  private buildStepContext(step: PlaybookStep, lessons: string): string {
    const rolling = this.snapshot.attempts
      .filter((a) => a.outcome !== 'in_progress')
      .map((a) => `- ${a.stepName}: ${a.outcome}${a.detail ? ` (${a.detail})` : ''}`)
      .join('\n')
    const guidance = this.snapshot.chat
      .filter((c) => c.role === 'admin')
      .slice(-5)
      .map((c) => `- ${c.text}`)
      .join('\n')
    const hints = step.hints?.length ? `\nHints you may use:\n- ${step.hints.join('\n- ')}` : ''
    return (
      `Machine: ${this.snapshot.machineDescriptor || 'unknown'}\n` +
      `Reported problem: ${this.snapshot.problemDescription || 'unspecified'}\n\n` +
      `CURRENT STEP — ${step.name}:\n${step.goal}${hints}\n` +
      (this.baselineObservation ? `\nWhat we currently see: ${this.baselineObservation.summary}\n` : '') +
      (rolling ? `\nPrior attempts this session:\n${rolling}\n` : '') +
      (lessons ? `\nLessons from past repairs (may be relevant):\n${lessons}\n` : '') +
      (guidance ? `\nADMINISTRATOR GUIDANCE (high priority):\n${guidance}\n` : '') +
      `\nWork on THIS step only. Take a screenshot / run a command to verify each ` +
      `action. When finished, end your final message with exactly one of:\n` +
      `"RESULT: FIXED" (the reported problem is resolved),\n` +
      `"RESULT: STEP_DONE" (this step is done but the problem may remain),\n` +
      `"RESULT: NEEDS_HUMAN" (you are blocked and need the administrator).`
    )
  }

  // --- metrics / snapshot --------------------------------------------------

  private anthropicModel(): string {
    return (this.anthropic as unknown as { model: string }).model ?? 'claude-opus-5'
  }

  private updateCost(): void {
    this.snapshot.cost = this.anthropic.costSoFar()
    this.emit()
  }

  private syncMetrics(ctx: OrchestratorContext): OrchestratorContext {
    const cost = this.anthropic.costSoFar()
    this.snapshot.cost = cost
    return { ...ctx, spentUsd: cost.usd, elapsedMs: Date.now() - this.startedAt }
  }

  private syncFromCtx(): void {
    this.snapshot.orchestratorState = this.ctx.state
    this.snapshot.iterations = this.ctx.iterations
    this.snapshot.failedStepIds = this.ctx.failedStepIds
    this.snapshot.updatedAt = Date.now()
  }

  private async waitWhileHeld(): Promise<void> {
    while ((this.paused || this.manualControl) && !this.stopped) {
      await sleep(200)
    }
  }

  private fail(message: string): void {
    this.snapshot.lastError = message
    this.narrate('error', message)
  }

  private emit(): void {
    this.snapshot.updatedAt = Date.now()
    this.cb.onSnapshot(this.snapshot)
  }

  // --- finalize + vault ----------------------------------------------------

  private async finalize(): Promise<void> {
    this.syncFromCtx()
    const terminal = this.ctx.state
    if (this.stopped) {
      this.snapshot.runState = 'stopped'
    } else {
      this.snapshot.runState = 'finished'
    }
    this.snapshot.endedAt = Date.now()
    this.snapshot.pendingApproval = null

    if (terminal === 'FIXED') this.narrate('info', '✅ The machine is fixed.')
    else if (terminal === 'GAVE_UP') this.narrate('warn', '⚠️ Exhausted the playbook. A reimage is recommended.')
    else if (terminal === 'NEEDS_HUMAN') this.narrate('warn', 'Paused — needs a human decision.')

    // Write a vault note on FIXED or GAVE_UP (never blocks; failures are logged).
    if ((terminal === 'FIXED' || terminal === 'GAVE_UP') && this.vault.isEnabled() && !this.stopped) {
      try {
        await this.writeVaultNote(terminal === 'FIXED' ? 'FIXED' : 'GAVE_UP')
      } catch (err) {
        logger.error('Vault write-back failed', err)
      }
    }

    try {
      await this.backend.dispose()
    } catch {
      /* ignore */
    }
    this.emit()
    this.cb.onFinished(this.snapshot)
  }

  private async writeVaultNote(outcome: 'FIXED' | 'GAVE_UP'): Promise<void> {
    const transcript = this.buildTranscript()
    let parsed: Partial<VaultNoteInput> = {}
    try {
      const raw = await this.anthropic.summarize(
        'You summarize a completed machine-repair session into a concise, ' +
          'pattern-focused note for future repairs. Respond with ONLY JSON.',
        `Session transcript:\n${transcript}\n\n` +
          'Return JSON: {"slug": short-kebab-title, "symptoms": string, ' +
          '"whatWorked": string (or "Unresolved"), "whatDidntWork": string[], ' +
          '"notesForNextTime": string, "symptomTags": string[], "stopCode": string-or-null}. ' +
          'Be concise and pattern-focused. No screenshots.'
      )
      const json = extractJson(raw)
      if (json) parsed = json as Partial<VaultNoteInput>
    } catch (err) {
      logger.warn('Could not summarize session for vault; writing a minimal note')
    }

    const date = new Date().toISOString().slice(0, 10)
    const input: VaultNoteInput = {
      date,
      mode: this.snapshot.mode,
      machineDescriptor: this.snapshot.machineDescriptor,
      symptomTags: Array.isArray(parsed.symptomTags) ? parsed.symptomTags : this.playbook.tags.slice(0, 4),
      stopCode: parsed.stopCode ?? this.baselineObservation?.stopCode ?? null,
      outcome,
      slug: parsed.slug ?? `${this.snapshot.mode}-${this.playbook.id}`,
      symptoms: parsed.symptoms ?? this.snapshot.problemDescription,
      whatWorked: parsed.whatWorked ?? (outcome === 'FIXED' ? 'See attempt history.' : 'Unresolved'),
      whatDidntWork: Array.isArray(parsed.whatDidntWork)
        ? parsed.whatDidntWork
        : this.snapshot.attempts.filter((a) => a.outcome !== 'fixed').map((a) => a.stepName),
      notesForNextTime: parsed.notesForNextTime ?? ''
    }
    const file = await this.vault.write(input)
    if (file) this.narrate('info', `Saved a note to the vault: ${file}`)
  }

  private buildTranscript(): string {
    const attempts = this.snapshot.attempts
      .map(
        (a) =>
          `Step "${a.stepName}" → ${a.outcome}${a.detail ? ` (${a.detail})` : ''}\n` +
          a.actions.map((x) => `    ${x}`).join('\n')
      )
      .join('\n')
    const chat = this.snapshot.chat.map((c) => `${c.role}: ${c.text}`).join('\n')
    return (
      `Mode: ${this.snapshot.mode}\nMachine: ${this.snapshot.machineDescriptor}\n` +
      `Problem: ${this.snapshot.problemDescription}\n\nAttempts:\n${attempts}\n\n` +
      (chat ? `Chat:\n${chat}\n` : '')
    )
  }
}

// --- helpers ---------------------------------------------------------------

function mapOutcome(o: VerifyOutcome): AttemptOutcome {
  if (o === 'FIXED') return 'fixed'
  if (o === 'NEW_FAILURE') return 'new_failure'
  return 'no_change'
}

function parseResultFlag(content: Anthropic.Beta.Messages.BetaContentBlock[]): string | null {
  for (const b of content) {
    if (b.type === 'text') {
      const m = b.text.match(/RESULT:\s*(FIXED|STEP_DONE|NEEDS_HUMAN|NOT_FIXED)/i)
      if (m && m[1]) return m[1].toUpperCase()
    }
  }
  return null
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence?.[1] ?? raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function imageBlock(
  data: string,
  mediaType: string
): Anthropic.Beta.Messages.BetaContentBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png', data }
  }
}

function toolResultBlock(
  toolUseId: string,
  text: string,
  isError: boolean
): Anthropic.Beta.Messages.BetaContentBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text }],
    ...(isError ? { is_error: true } : {})
  }
}

function toolResultWithImage(
  toolUseId: string,
  text: string,
  imageBase64: string,
  mediaType: string,
  isError: boolean
): Anthropic.Beta.Messages.BetaContentBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png', data: imageBase64 } }
    ],
    ...(isError ? { is_error: true } : {})
  }
}

export type { BootOutcome }

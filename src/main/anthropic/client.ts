import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '../logger'
import { FALLBACK_PRICING, MODEL_PRICING, RETRY_BASE_MS, RETRY_MAX_MS } from '@shared/constants'
import type { CostInfo } from '@shared/types'

const logger = createLogger('anthropic')

// The SDK's beta message/content param types.
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam
export type BetaMessage = Anthropic.Beta.Messages.BetaMessage
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock

export interface CreateStepParams {
  model: string
  system: string
  messages: BetaMessageParam[]
  /** Tool definitions (computer-use schema-less or custom). */
  tools: Record<string, unknown>[]
  betas: string[]
  maxTokens?: number
}

function priceUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] ?? FALLBACK_PRICING
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Wraps the Anthropic SDK with running cost estimation and an outer retry with
 * exponential backoff on top of the SDK's own retries. Every external call is
 * defensive: a transient failure retries, a hard failure surfaces a plain
 * message instead of throwing a raw stack into the UI.
 */
export class AnthropicService {
  private client: Anthropic
  private cost: CostInfo = { inputTokens: 0, outputTokens: 0, usd: 0 }

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 4, timeout: 120_000 })
  }

  setModel(model: string): void {
    this.model = model
  }

  costSoFar(): CostInfo {
    return { ...this.cost }
  }

  resetCost(): void {
    this.cost = { inputTokens: 0, outputTokens: 0, usd: 0 }
  }

  private accrue(model: string, usage: Anthropic.Beta.Messages.BetaUsage | undefined): void {
    if (!usage) return
    const inp =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    const out = usage.output_tokens ?? 0
    this.cost.inputTokens += inp
    this.cost.outputTokens += out
    this.cost.usd += priceUsd(model, inp, out)
  }

  /** One turn of the agent loop for a step, with retry/backoff. */
  async createStep(params: CreateStepParams): Promise<BetaMessage> {
    const body = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      betas: params.betas
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

    let attempt = 0
    // The SDK retries 429/5xx internally; this outer loop covers connection
    // errors and gives us backoff + user-visible logging.
    for (;;) {
      try {
        const msg = (await this.client.beta.messages.create(body)) as BetaMessage
        this.accrue(params.model, msg.usage)
        return msg
      } catch (err) {
        attempt += 1
        const retriable = isRetriable(err)
        if (!retriable || attempt >= 5) {
          logger.error('Anthropic request failed', err)
          throw new Error(humanApiError(err))
        }
        const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
        logger.warn(`Anthropic request retry ${attempt} in ${delay}ms`)
        await sleep(delay)
      }
    }
  }

  /**
   * A vision call that returns the model's raw text (used by the boot watcher to
   * classify a screen). Costs are tracked. Retries on transient failure.
   */
  async visionText(
    system: string,
    text: string,
    imageBase64: string,
    mediaType: string,
    maxTokens = 400
  ): Promise<string> {
    let attempt = 0
    for (;;) {
      try {
        const msg = await this.client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType as 'image/jpeg' | 'image/png',
                    data: imageBase64
                  }
                }
              ]
            }
          ]
        })
        this.accrue(this.model, msg.usage as unknown as Anthropic.Beta.Messages.BetaUsage)
        return msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
      } catch (err) {
        attempt += 1
        if (!isRetriable(err) || attempt >= 4) {
          logger.error('Anthropic vision call failed', err)
          throw new Error(humanApiError(err))
        }
        await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS))
      }
    }
  }

  /**
   * A plain summarization call (used for vault notes and chat replies). Returns
   * the concatenated text of the response. Costs are tracked too.
   */
  async summarize(system: string, prompt: string, maxTokens = 1500): Promise<string> {
    let attempt = 0
    for (;;) {
      try {
        const msg = await this.client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }]
        })
        this.accrue(this.model, msg.usage as unknown as Anthropic.Beta.Messages.BetaUsage)
        return msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
      } catch (err) {
        attempt += 1
        if (!isRetriable(err) || attempt >= 4) {
          logger.error('Anthropic summarize failed', err)
          throw new Error(humanApiError(err))
        }
        await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS))
      }
    }
  }
}

function isRetriable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.RateLimitError) return true
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    return status >= 500 || status === 408 || status === 409
  }
  return false
}

function humanApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key. Check it in Settings.'
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Anthropic rate limit hit. Waiting and retrying.'
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API. Check the network connection.'
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error (${err.status ?? 'unknown'}): ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * App-wide constants. Model names and tool/beta versions live here as config
 * constants so a single edit re-points the whole agent stack.
 */

/** Default Claude model for the agent loop. Overridable in Settings. */
export const DEFAULT_MODEL = 'claude-opus-5'

/** Computer-use tool + beta header versions (see JetKVM/computer-use docs). */
export const COMPUTER_USE_TOOL_TYPE = 'computer_20251124'
export const COMPUTER_USE_BETA = 'computer-use-2025-11-24'

/**
 * Screenshot geometry we advertise to the computer-use tool. The reference
 * agent loop recommends ~1280x800; we downscale KVM frames to fit inside this
 * box (preserving aspect) before sending, then scale coordinates back.
 */
export const MODEL_DISPLAY_WIDTH = 1280
export const MODEL_DISPLAY_HEIGHT = 800

/** JetKVM absolute-mouse coordinate maximum (HID Logical Maximum 0x7FFF). */
export const KVM_ABS_MAX = 32767

/** HID keyboard modifier bit flags (standard USB HID). */
export const HID_MODIFIER = {
  LeftCtrl: 0x01,
  LeftShift: 0x02,
  LeftAlt: 0x04,
  LeftGui: 0x08,
  RightCtrl: 0x10,
  RightShift: 0x20,
  RightAlt: 0x40,
  RightGui: 0x80
} as const

/** JetKVM absolute-mouse button bitmask. */
export const KVM_MOUSE_BUTTON = {
  Left: 0x01,
  Right: 0x02,
  Middle: 0x04
} as const

/**
 * Approximate token pricing per 1M tokens (USD), for cost estimation only.
 * Kept intentionally simple — this drives the "API cost so far" readout and the
 * per-session spend cap, not billing.
 */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 }
}

/** Fallback pricing when the model isn't in the table above. */
export const FALLBACK_PRICING = { inputPerMTok: 5, outputPerMTok: 25 }

/** Default hard caps per repair session. */
export const DEFAULT_CAPS = {
  maxIterations: 40,
  maxSpendUsd: 5,
  maxWallClockMs: 45 * 60 * 1000
}

/** Boot watcher: poll frames for up to this long after a reboot. */
export const BOOT_WATCHER_TIMEOUT_MS = 5 * 60 * 1000
export const BOOT_WATCHER_POLL_MS = 5000

/** Connection retry backoff (exponential, capped). */
export const RETRY_BASE_MS = 2000
export const RETRY_MAX_MS = 30000
export const RETRY_MAX_ATTEMPTS = 8

/** Directory name inside the Obsidian vault for our notes. */
export const VAULT_SUBDIR = 'TroubleCrack'

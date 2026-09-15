/**
 * Thinking-config pipeline (S2d2 section 3.3).
 *
 * Two stages are observable on the wire and both are reproduced: the
 * translator stage converts `thinkingLevel`/`thinkingBudget` into a
 * `reasoning_effort` value, then the request-thinking stage re-reads the
 * ORIGINAL Gemini body, validates the level against the selected model's
 * capability and rewrites `reasoning_effort` in the translated body in
 * place. The stage-2 EFFECTIVE mapping is the recorded contract: `auto`
 * clamps to the capability's mid level, `none`/`minimal` clamp to the
 * lowest, `xhigh`/`max` clamp to the highest, and anything outside the
 * canonical ladder fails the request with 400.
 */
import { CpaError } from '@cpa-edge/core'
import { DEFAULT_OPENAI_COMPAT_THINKING } from './types'
import type { ThinkingCapability, WireObject } from './types'

/**
 * Reasoning levels the pipeline understands as INPUT. A level outside this
 * ladder is not a clamp candidate: it fails validation with 400 (the
 * message lists the capability's supported levels).
 */
const CANONICAL_LEVELS: readonly string[] = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const AUTO_LEVEL = 'auto'

/**
 * Converts a thinking budget to its ladder level (stage 1):
 * -1 -> `auto`, 0 -> `none`, 1..512 -> `minimal`, 513..1024 -> `low`,
 * 1025..8192 -> `medium`, 8193..24576 -> `high`, >= 24577 -> `xhigh`.
 * Budgets below -1 convert to nothing and fail stage 2 with 400.
 */
export function convertBudgetToLevel(budget: number): string | undefined {
  if (budget === -1) return AUTO_LEVEL
  if (budget === 0) return 'none'
  if (budget >= 1 && budget <= 512) return 'minimal'
  if (budget > 512 && budget <= 1024) return 'low'
  if (budget > 1024 && budget <= 8192) return 'medium'
  if (budget > 8192 && budget <= 24576) return 'high'
  if (budget > 24576) return 'xhigh'
  return undefined
}

function ladderRank(level: string): number {
  return CANONICAL_LEVELS.indexOf(level)
}

/** Mid-range level of a capability (`auto` clamps here). */
function midRangeLevel(capability: ThinkingCapability): string {
  const levels = capability.levels
  return levels[Math.floor(levels.length / 2)] ?? levels[0] ?? ''
}

/**
 * Validates a level against the capability and returns the EFFECTIVE level
 * (stage 2 mapping). `none` clamps to the lowest level unless the capability
 * allows disable (then the effort is dropped and this returns `undefined`);
 * out-of-range but canonical levels clamp to the nearest supported level;
 * non-canonical levels fail with the recorded 400 message.
 */
export function effectiveThinkingLevel(
  level: string,
  capability: ThinkingCapability = DEFAULT_OPENAI_COMPAT_THINKING,
): string | undefined {
  const levels = capability.levels
  if (levels.includes(level)) return level
  if (level === AUTO_LEVEL) return midRangeLevel(capability)
  if (level === 'none') {
    if (capability.disableAllowed === true) return undefined
    return levels[0] ?? ''
  }
  const rank = ladderRank(level)
  if (rank < 0) {
    throw new CpaError(
      'invalid-input',
      `level "${level}" not supported, valid levels: ${levels.join(', ')}`,
    )
  }
  // Canonical but unsupported: clamp to the nearest supported level.
  const ranks = levels.map((supported) => ladderRank(supported)).filter((value) => value >= 0)
  if (ranks.length === 0) return levels[0] ?? ''
  if (rank < Math.min(...ranks)) return levels[0] ?? ''
  if (rank > Math.max(...ranks)) return levels[levels.length - 1] ?? ''
  // The level sits inside the capability's range but is not listed
  // individually (a sparse levels list); clamp to the nearest lower level.
  let best = levels[0] ?? ''
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < levels.length; i++) {
    const supportedRank = ladderRank(levels[i] ?? '')
    if (supportedRank < 0) continue
    const distance = Math.abs(supportedRank - rank)
    if (distance < bestDistance || (distance === bestDistance && supportedRank < rank)) {
      bestDistance = distance
      best = levels[i] ?? best
    }
  }
  return best
}

/** Thinking config as extracted from the ORIGINAL Gemini body. */
export interface SourceThinkingConfig {
  /** Lowercased+trimmed `thinkingLevel` / `thinking_level`, when present. */
  readonly level?: string
  /** Raw `thinkingBudget` / `thinking_budget` number, when present. */
  readonly budget?: number
}

/**
 * Stage-2 source extraction: re-reads the thinking config from the original
 * Gemini body. The level key wins over the budget key.
 */
export function extractSourceThinkingConfig(source: unknown): SourceThinkingConfig {
  if (typeof source !== 'object' || source === null) return {}
  const request = source as Record<string, unknown>
  const generationConfig = request['generationConfig']
  if (typeof generationConfig !== 'object' || generationConfig === null) return {}
  const config = generationConfig as Record<string, unknown>
  const thinking = config['thinkingConfig']
  if (typeof thinking !== 'object' || thinking === null) return {}
  const record = thinking as Record<string, unknown>
  const levelRaw = readStringKey(record, 'thinkingLevel') ?? readStringKey(record, 'thinking_level')
  const level = levelRaw !== undefined ? levelRaw.trim().toLowerCase() : undefined
  const budgetRaw = record['thinkingBudget'] ?? record['thinking_budget']
  const budget = typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : undefined
  const out: { level?: string; budget?: number } = {}
  if (level !== undefined && level.length > 0) out.level = level
  if (budget !== undefined) out.budget = budget
  return out
}

function readStringKey(record: Record<string, unknown>, key: string): string | undefined {
  const raw = record[key]
  return typeof raw === 'string' ? raw : undefined
}

/**
 * Stage 2: rewrites `reasoning_effort` in the translated body per the
 * effective mapping. Key position is preserved: the value is only written
 * when stage 1 placed the key, and `none` on a disable-capable model
 * removes it. Throws the recorded 400 `CpaError` for unknown levels and
 * unconvertible budgets.
 */
export function applyRequestThinking(
  body: WireObject,
  source: unknown,
  capability: ThinkingCapability = DEFAULT_OPENAI_COMPAT_THINKING,
): void {
  if (body['reasoning_effort'] === undefined) return
  const config = extractSourceThinkingConfig(source)
  if (config.level !== undefined) {
    const effective = effectiveThinkingLevel(config.level, capability)
    if (effective === undefined) delete body['reasoning_effort']
    else body['reasoning_effort'] = effective
    return
  }
  if (config.budget !== undefined) {
    const converted = convertBudgetToLevel(config.budget)
    if (converted === undefined) {
      throw new CpaError(
        'invalid-input',
        `budget ${formatBudget(config.budget)} cannot be converted to a valid level`,
      )
    }
    const effective = effectiveThinkingLevel(converted, capability)
    if (effective === undefined) delete body['reasoning_effort']
    else body['reasoning_effort'] = effective
  }
}

/** Budget values print without a trailing `.0` on integer inputs. */
function formatBudget(budget: number): string {
  return String(budget)
}

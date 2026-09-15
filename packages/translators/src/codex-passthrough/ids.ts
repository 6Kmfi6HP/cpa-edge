
/**
 * Input-item id normalization for the Codex passthrough (S2d9 section 3.2).
 *
 * Codex upstreams key stateful continuation off typed item ids
 * (`msg_`, `rs_`, `fc_`, `ctc_`, `ctco_`). The gateway re-prefixes bare
 * ids, keeps empty ids empty, passes correctly prefixed ids through, and
 * shortens ids past 64 runes with a deterministic SHA-256 suffix so the
 * upstream never sees an oversized key. A re-prefixed id that would
 * collide with a preserved id takes a hashed variant instead; an
 * encrypted reasoning item whose id is overlong is dropped from the input
 * entirely. The recorded fixtures pin the rule set, not the exact hash
 * format (no golden carries a rewritten id).
 */
import { sha256Hex } from './hash'

/** Rune cap the upstream accepts on an item id. */
export const ITEM_ID_RUNE_LIMIT = 64

/** Runes kept from the original id when a hash suffix must fit inside the cap. */
const KEEP_RUNES = ITEM_ID_RUNE_LIMIT - 9 // '-' plus an 8-hex digest

/** Item types the id rules cover, with their id prefixes. */
export const ITEM_ID_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  message: 'msg_',
  reasoning: 'rs_',
  function_call: 'fc_',
  custom_tool_call: 'ctc_',
  custom_tool_call_output: 'ctco_',
})

/** What the rewrite wants to do with one item. */
export type ItemIdAction =
  | { readonly kind: 'keep' }
  | { readonly kind: 'rewrite'; readonly value: string }
  | { readonly kind: 'drop' }

export interface ItemIdInput {
  /** Parsed `type` of the input item (absent/other types are skipped). */
  readonly type: unknown
  /** Parsed `id` member of the input item. */
  readonly id: unknown
  /** True when a reasoning item carries a structurally valid `encrypted_content`. */
  readonly encryptedValid: boolean
}

/**
 * Computes the id action for every item in one pass. The plan is
 * deterministic: identical inputs always produce identical bytes.
 */
export async function planInputItemIds(items: readonly ItemIdInput[]): Promise<readonly ItemIdAction[]> {
  const prefixOf = (index: number): string | undefined => {
    const item = items[index]
    if (item === undefined || typeof item.type !== 'string') return undefined
    return ITEM_ID_PREFIXES[item.type]
  }
  const idOf = (index: number): string | undefined => {
    const item = items[index]
    if (item === undefined || typeof item.id !== 'string') return undefined
    return item.id
  }

  // Preserved ids: non-empty, already carrying their type prefix.
  const preserved = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const prefix = prefixOf(i)
    const id = idOf(i)
    if (prefix === undefined || id === undefined || id.length === 0) continue
    if (id.startsWith(prefix)) preserved.add(id)
  }

  const taken = new Set<string>()
  const actions: ItemIdAction[] = []
  for (let i = 0; i < items.length; i++) {
    const prefix = prefixOf(i)
    const id = idOf(i)
    if (prefix === undefined) {
      actions.push({ kind: 'keep' })
      continue
    }
    if (id === undefined) {
      actions.push({ kind: 'keep' })
      continue
    }
    if (id.length === 0) {
      actions.push({ kind: 'keep' })
      continue
    }
    // Encrypted reasoning state cannot survive a shortened id: the whole
    // item leaves the input.
    if (items[i]?.encryptedValid === true && countRunes(id) > ITEM_ID_RUNE_LIMIT) {
      actions.push({ kind: 'drop' })
      continue
    }
    if (id.startsWith(prefix)) {
      if (countRunes(id) <= ITEM_ID_RUNE_LIMIT) {
        taken.add(id)
        actions.push({ kind: 'keep' })
        continue
      }
      const shortened = await shortenUnique(id, taken)
      taken.add(shortened)
      actions.push({ kind: 'rewrite', value: shortened })
      continue
    }
    const rePrefixed = `${prefix}${id}`
    const unique = await uniquify(rePrefixed, preserved, taken)
    taken.add(unique)
    actions.push({ kind: 'rewrite', value: unique })
  }
  return actions
}

/** Number of Unicode code points of a text. */
function countRunes(text: string): number {
  return Array.from(text).length
}

/**
 * Fits a value inside the rune cap by keeping a head of the original and
 * appending a digest suffix; collisions retry with salted digests.
 */
async function shortenUnique(value: string, taken: ReadonlySet<string>): Promise<string> {
  const base = Array.from(value).slice(0, KEEP_RUNES).join('')
  for (let attempt = 0; ; attempt++) {
    const digest = await sha256Hex(attempt === 0 ? value : `${value}\0${attempt}`)
    const candidate = `${base}-${digest.slice(0, 8)}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Picks the wire form of a re-prefixed id: the plain value unless a
 * preserved or already-taken id owns it, in which case a hashed variant
 * (still within the rune cap) is used.
 */
async function uniquify(value: string, preserved: ReadonlySet<string>, taken: ReadonlySet<string>): Promise<string> {
  let base = value
  if (countRunes(base) > ITEM_ID_RUNE_LIMIT) {
    const digest = await sha256Hex(base)
    base = `${Array.from(base).slice(0, KEEP_RUNES).join('')}-${digest.slice(0, 8)}`
  }
  if (!preserved.has(base) && !taken.has(base)) return base
  for (let attempt = 1; ; attempt++) {
    const digest = await sha256Hex(`${value}\0${attempt}`)
    const candidate = `${Array.from(value).slice(0, KEEP_RUNES).join('')}-${digest.slice(0, 8)}`
    if (!preserved.has(candidate) && !taken.has(candidate)) return candidate
  }
}

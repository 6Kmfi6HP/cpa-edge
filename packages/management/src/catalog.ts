/**
 * Static per-channel model catalogs (S5 model-definitions and
 * auth-files/models): the fallback catalog embedded in the reference image,
 * transcribed from the recorded kimi golden (the only channel the fixtures
 * pin byte-exactly) plus the channel alias table.
 */

export interface CatalogModel {
  readonly id: string
  readonly object: 'model'
  readonly created: number
  readonly owned_by: string
  readonly type: string
  readonly display_name: string
  readonly description: string
  readonly context_length: number
  readonly max_completion_tokens: number
  readonly supportedInputModalities: readonly string[]
  readonly supportedOutputModalities: readonly string[]
  readonly thinking?: { readonly [key: string]: unknown }
}

export const KIMI_CATALOG: readonly CatalogModel[] = [
  {
    id: "kimi-k2",
    object: 'model',
    created: 1752192000,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2",
    description: "Kimi K2 - Moonshot AI's flagship coding model",
    context_length: 131072,
    max_completion_tokens: 32768,
    supportedInputModalities: ["text"],
    supportedOutputModalities: ["text"],
  },
  {
    id: "kimi-k2-thinking",
    object: 'model',
    created: 1762387200,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2 Thinking",
    description: "Kimi K2 Thinking - Extended reasoning model",
    context_length: 131072,
    max_completion_tokens: 32768,
    supportedInputModalities: ["text"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high"] },
  },
  {
    id: "kimi-k2.5",
    object: 'model',
    created: 1769472000,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2.5",
    description: "Kimi K2.5 - Native multimodal agentic model with text, image, and video input; supports thinking and non-thinking modes",
    context_length: 262144,
    max_completion_tokens: 32768,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high"] },
  },
  {
    id: "kimi-k2.6",
    object: 'model',
    created: 1776729600,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2.6",
    description: "Kimi K2.6 - Native multimodal agentic model with stronger long-horizon agentic coding, long-context reasoning, and preserved thinking support",
    context_length: 262144,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high"] },
  },
  {
    id: "kimi-k2.7-code",
    object: 'model',
    created: 1780396800,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2.7 Code",
    description: "Kimi K2.7 Code - Moonshot AI's latest coding-focused model",
    context_length: 262144,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { levels: ["low", "high"] },
  },
  {
    id: "kimi-k2.7-code-highspeed",
    object: 'model',
    created: 1780396800,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2.7 Code HighSpeed",
    description: "Kimi K2.7 Code HighSpeed - Same capabilities as Kimi K2.7 Code with higher output speed (~180 tokens/s)",
    context_length: 262144,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { levels: ["low", "high"] },
  },
  {
    id: "kimi-k2.8",
    object: 'model',
    created: 1789115500,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2.8 Preview",
    description: "Kimi K2.8 Preview - Lightweight coding and agent model with near-K3 performance and 1M context window",
    context_length: 1048576,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high", "max"] },
  },
  {
    id: "kimi-k2.8-code",
    object: 'model',
    created: 1789115500,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K2.8 Code Preview",
    description: "Kimi K2.8 Code Preview - Lightweight coding and agent model with near-K3 performance and 1M context window",
    context_length: 1048576,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high", "max"] },
  },
  {
    id: "kimi-k3",
    object: 'model',
    created: 1784073600,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K3",
    description: "Kimi K3 - Moonshot AI's next-generation flagship model (~2.8T MoE) with multimodal input",
    context_length: 1048576,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image", "video"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high", "max"] },
  },
  {
    id: "kimi-k3-256k",
    object: 'model',
    created: 1785110400,
    owned_by: "moonshot",
    type: "kimi",
    display_name: "Kimi K3 256K",
    description: "Kimi K3 256K - 256K context version of Kimi K3 delivering the same results within 256K context at reduced quota consumption; supports image input only (no video)",
    context_length: 262144,
    max_completion_tokens: 65536,
    supportedInputModalities: ["text", "image"],
    supportedOutputModalities: ["text"],
    thinking: { zero_allowed: true, levels: ["low", "high", "max"] },
  },
]

/** Channel alias table of `GET /model-definitions/:channel`. */
const CHANNEL_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude',
  gemini: 'gemini',
  'gemini-interactions': 'gemini-interactions',
  vertex: 'vertex',
  aistudio: 'aistudio',
  codex: 'codex',
  kimi: 'kimi',
  antigravity: 'antigravity',
  xai: 'xai',
  'x-ai': 'xai',
  grok: 'xai',
  devin: 'devin',
  meta: 'meta',
  muse: 'meta',
}

/** Resolves a channel request path segment to its canonical channel. */
export function canonicalChannel(raw: string): string | undefined {
  return CHANNEL_ALIASES[raw.toLowerCase()]
}

/** The full-field catalog of one channel (only kimi is fixture-pinned). */
export function channelCatalog(channel: string): readonly CatalogModel[] | undefined {
  if (channel === 'kimi') return KIMI_CATALOG
  return undefined
}

/** The 4-key alphabetical form used by `GET /auth-files/models`. */
export function authFileModels(channel: string): ReadonlyArray<Record<string, string>> {
  const catalog = channelCatalog(channel)
  if (catalog === undefined) return []
  return catalog.map((model) => ({
    display_name: model.display_name,
    id: model.id,
    owned_by: model.owned_by,
    type: model.type,
  }))
}

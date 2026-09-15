/**
 * Runtime configuration ingestion (S6 §3.1 config document shape).
 *
 * The gateway accepts a plain, YAML-shaped configuration object - the
 * same key names as the reference `config.yaml` (public interface). A
 * file loader can map a parsed YAML document onto this value verbatim.
 * Everything defensive happens here once; handlers work on the
 * normalized result only.
 */
import { asPlainObject, readNumber, readObject, readString } from '@cpa-edge/auth'
import { cla2gem, cla2oai, codexPassthrough, gem2cla, gem2oai, oai2cla, oai2codex, oai2gem, res2oai } from '@cpa-edge/translators'

/** Provider families the registry and dispatch table know about. */
export type ProviderFamily =
  | 'openai-compatibility'
  | 'gemini-api-key'
  | 'claude-api-key'
  | 'codex-api-key'
  | 'xai-api-key'
  | 'meta-api-key'
  | 'interactions-api-key'
  | 'vertex-api-key'

/**
 * Registration order of the provider families. The reference resolves
 * aliases by registration sequence; api-key sections register in this
 * fixed family order (S4 owns the precise cross-provider ordering; the
 * runtime keeps first-match, config order for Phase A).
 */
export const FAMILY_ORDER: readonly ProviderFamily[] = [
  'openai-compatibility',
  'gemini-api-key',
  'claude-api-key',
  'codex-api-key',
  'xai-api-key',
  'meta-api-key',
  'interactions-api-key',
  'vertex-api-key',
]

/** One model entry of a provider block (S6 §3.1.4 `models[]`). */
export interface ProviderModelEntry {
  /** Upstream model id (alias target). */
  readonly name: string
  /** Client-facing id; defaults to `name`. */
  readonly alias: string
  /** LIST-only display name (`display-name`). */
  readonly displayName?: string
  /** openai-compatibility model flag: image-capable model. */
  readonly image: boolean
  /** claude `is-compat` flag (assistant reasoning replay). */
  readonly isCompat: boolean
  /** `force-mapping` (response model rewrite back to the alias). */
  readonly forceMapping: boolean
  /** Thinking capability block, config verbatim. */
  readonly thinking?: {
    readonly min?: number
    readonly max?: number
    readonly levels?: readonly string[]
  }
}

/** One normalized api-key provider entry. */
export interface ProviderEntry {
  readonly family: ProviderFamily
  /** Provider id (openai-compatibility `name`) or the family default. */
  readonly providerName: string
  readonly apiKey: string
  readonly baseUrl: string
  /** Provider-level static header map (trimmed, non-empty). */
  readonly headers: Readonly<Record<string, string>>
  /** `fingerprint-profile` (claude-api-key). */
  readonly fingerprintProfile?: string
  readonly models: readonly ProviderModelEntry[]
}

/** Four-state image gate (S1 §3.2): false | true | "chat" | "passthrough". */
export type ImageGenerationMode = false | true | 'chat' | 'passthrough'

/** Normalized gateway configuration. */
export interface NormalizedConfig {
  readonly port: number
  /** Top-level client api-keys (verbatim; auth normalizes them). */
  readonly apiKeys: readonly string[]
  readonly remoteManagement: {
    readonly allowRemote: boolean
    readonly secretKey: string
    readonly disableControlPanel: boolean
  }
  /** true only for the literal `true` state (images routes absent). */
  readonly imageGenerationMode: ImageGenerationMode
  readonly disableCloakingModelList: boolean
  /** `codex.disable-codex-cloaking`: keeps the caller UA/originator wire. */
  readonly disableCodexCloaking: boolean
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
  readonly providers: readonly ProviderEntry[]
}

/**
 * The YAML-shaped input object. Keys are the public config names
 * (`api-keys`, `remote-management`, provider sections, ...); values are
 * plain JSON scalars/maps/lists. Unknown keys are ignored.
 */
export type RuntimeConfigInput = Readonly<Record<string, unknown>>

/** Default Claude upstream when `claude-api-key` omits `base-url` (S6). */
export const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com'

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out
}

const readHeaderMap = (value: unknown): Record<string, string> => {
  const source = asPlainObject(value)
  const out: Record<string, string> = {}
  if (source === undefined) return out
  for (const [key, raw] of Object.entries(source)) {
    const name = key.trim()
    const val = typeof raw === 'string' ? raw.trim() : ''
    if (name.length === 0 || val.length === 0) continue
    out[name] = val
  }
  return out
}

interface RawModelSource {
  readonly name: string
  readonly alias: string
  readonly displayName?: string
  readonly image: boolean
  readonly isCompat: boolean
  readonly forceMapping: boolean
  readonly thinking?: { min?: number; max?: number; levels?: readonly string[] }
}

const readModels = (value: unknown): readonly RawModelSource[] => {
  if (!Array.isArray(value)) return []
  const out: RawModelSource[] = []
  for (const item of value) {
    const record = asPlainObject(item)
    if (record === undefined) continue
    const name = readString(record, 'name')
    if (name === undefined || name.length === 0) continue
    const alias = readString(record, 'alias')
    const displayName = readString(record, 'display-name')
    const thinkingSource = readObject(record, 'thinking')
    let thinking: RawModelSource['thinking']
    if (thinkingSource !== undefined) {
      const levels = readStringArray(thinkingSource['levels'])
      const min = readNumber(thinkingSource, 'min')
      const max = readNumber(thinkingSource, 'max')
      thinking = {
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(levels.length === 0 ? {} : { levels }),
      }
    }
    out.push({
      name,
      alias: alias !== undefined && alias.length > 0 ? alias : name,
      ...(displayName === undefined || displayName.length === 0 ? {} : { displayName }),
      image: record['image'] === true,
      isCompat: record['is-compat'] === true,
      forceMapping: record['force-mapping'] === true,
      ...(thinking === undefined ? {} : { thinking }),
    })
  }
  return out
}

const readImageGenerationMode = (value: unknown): ImageGenerationMode => {
  if (value === true) return true
  if (value === 'chat') return 'chat'
  if (value === 'passthrough') return 'passthrough'
  return false
}

const providerNameOf = (family: ProviderFamily, raw: Readonly<Record<string, unknown>>): string => {
  const configured = readString(raw, 'name')
  if (configured !== undefined && configured.length > 0) return configured
  // Family default ids double as `owned_by` and cooldown `provider` names.
  return family === 'openai-compatibility'
    ? 'openai-compatibility'
    : family.replace('-api-key', '').replace('-compatibility', '')
}

const baseUrlOf = (family: ProviderFamily, raw: Readonly<Record<string, unknown>>): string => {
  const configured = readString(raw, 'base-url')
  if (configured !== undefined && configured.length > 0) return configured
  return family === 'claude-api-key' ? DEFAULT_CLAUDE_BASE_URL : ''
}

/**
 * Reads and normalizes one provider family section. Entries without an
 * `api-key` (or without `base-url` where the reference drops the entry)
 * are skipped; models without a `name` are skipped.
 */
const readProviderSection = (family: ProviderFamily, value: unknown): ProviderEntry[] => {
  if (!Array.isArray(value)) return []
  const out: ProviderEntry[] = []
  for (const item of value) {
    const raw = asPlainObject(item)
    if (raw === undefined) continue
    const apiKey = readString(raw, 'api-key') ?? ''
    const baseUrl = baseUrlOf(family, raw)
    if (apiKey.length === 0 && baseUrl.length === 0) continue
    const requiresBaseUrl =
      family === 'codex-api-key' ||
      family === 'xai-api-key' ||
      family === 'meta-api-key' ||
      family === 'openai-compatibility'
    if (requiresBaseUrl && baseUrl.length === 0) continue
    const fingerprintProfile = readString(raw, 'fingerprint-profile') ?? ''
    out.push({
      family,
      providerName: providerNameOf(family, raw),
      apiKey,
      baseUrl,
      headers: readHeaderMap(raw['headers']),
      ...(fingerprintProfile.length === 0 ? {} : { fingerprintProfile }),
      models: readModels(raw['models']),
    })
  }
  return out
}

/** Normalizes the YAML-shaped config object into the runtime form. */
export function normalizeRuntimeConfig(input: RuntimeConfigInput): NormalizedConfig {
  const remoteManagementSource = readObject(input, 'remote-management') ?? {}
  const providers: ProviderEntry[] = []
  for (const family of FAMILY_ORDER) {
    providers.push(...readProviderSection(family, input[family]))
  }
  const claudeCodeSource = readObject(input, 'claude-code') ?? {}
  const codexSource = readObject(input, 'codex') ?? {}
  return {
    port: readNumber(input, 'port') ?? 0,
    apiKeys: readStringArray(input['api-keys']),
    remoteManagement: {
      allowRemote: remoteManagementSource['allow-remote'] === true,
      secretKey: readString(remoteManagementSource, 'secret-key') ?? '',
      disableControlPanel: remoteManagementSource['disable-control-panel'] === true,
    },
    imageGenerationMode: readImageGenerationMode(input['disable-image-generation']),
    disableCloakingModelList: claudeCodeSource['disable-cloaking-model-list'] === true,
    disableCodexCloaking: codexSource['disable-codex-cloaking'] === true,
    requestRetry: readNumber(input, 'request-retry') ?? 0,
    transientErrorCooldownSeconds: readNumber(input, 'transient-error-cooldown-seconds') ?? 0,
    providers,
  }
}

/** Maps the normalized claude-api-key entries onto the oai2cla facade shape. */
export function claudeCredentialsForChat(config: NormalizedConfig): readonly oai2cla.Oai2ClaCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'claude-api-key')
    .map((provider) => ({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      ...(provider.fingerprintProfile === 'claude-code-cli'
        ? { fingerprintProfile: 'claude-code-cli' as const }
        : {}),
      models: provider.models.map((model) => ({
        name: model.name,
        alias: model.alias,
        ...(model.isCompat ? { isCompat: true } : {}),
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
      })),
    }))
}

/** Maps openai-compatibility entries onto the gem2oai facade shape. */
export function openAiCompatCredentials(config: NormalizedConfig): readonly gem2oai.Gem2OaiCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'openai-compatibility')
    .map((provider) => ({
      name: provider.providerName,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      ...(Object.keys(provider.headers).length === 0 ? {} : { headers: provider.headers }),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
        ...(model.thinking?.levels !== undefined ? { thinking: { levels: model.thinking.levels } } : {}),
        ...(model.forceMapping ? { forceMapping: true } : {}),
      })),
    }))
}

/** Maps codex-api-key entries onto the oai2codex facade shape. */
export function codexCredentialsForChat(config: NormalizedConfig): readonly oai2codex.Oai2CodexCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'codex-api-key')
    .map((provider) => ({
      apiKey: provider.apiKey,
      ...(provider.baseUrl.length > 0 ? { baseUrl: provider.baseUrl } : {}),
      ...(Object.keys(provider.headers).length === 0 ? {} : { headers: provider.headers }),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
        ...(model.thinking === undefined ? {} : { thinking: true }),
      })),
    }))
}

/** Maps openai-compatibility entries onto the res2oai facade shape. */
export function openAiCompatCredentialsForResponses(config: NormalizedConfig): readonly res2oai.Res2OaiCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'openai-compatibility')
    .map((provider) => ({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      provider: provider.providerName,
      ...(Object.keys(provider.headers).length === 0 ? {} : { headers: provider.headers }),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
      })),
    }))
}

/** Maps codex-api-key entries onto the codex-passthrough facade shape. */
export function codexCredentialsForPassthrough(config: NormalizedConfig): readonly codexPassthrough.CodexPassthroughCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'codex-api-key')
    .map((provider) => ({
      apiKey: provider.apiKey,
      ...(provider.baseUrl.length > 0 ? { baseUrl: provider.baseUrl } : {}),
      ...(Object.keys(provider.headers).length === 0 ? {} : { headers: provider.headers }),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
        ...(model.forceMapping ? { forceMapping: true } : {}),
        ...(model.thinking === undefined ? {} : { thinking: true }),
      })),
    }))
}

/** Maps gemini-api-key entries onto the oai2gem facade shape. */
export function geminiCredentialsForChat(config: NormalizedConfig): readonly oai2gem.Oai2GemCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'gemini-api-key')
    .map((provider) => ({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl.length > 0 ? provider.baseUrl : oai2gem.DEFAULT_GEMINI_BASE_URL,
      ...(Object.keys(provider.headers).length === 0 ? {} : { headers: provider.headers }),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
        ...(model.forceMapping ? { forceMapping: true } : {}),
        ...(model.thinking?.levels !== undefined ? { thinking: { levels: model.thinking.levels } } : {}),
      })),
    }))
}

/** Maps openai-compatibility entries onto the cla2oai facade shape. */
export function openAiCompatCredentialsForMessages(config: NormalizedConfig): readonly cla2oai.Cla2OaiCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'openai-compatibility')
    .map((provider) => ({
      name: provider.providerName,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      ...(Object.keys(provider.headers).length === 0 ? {} : { headers: provider.headers }),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
        ...(model.isCompat ? { isCompat: true } : {}),
        ...(model.thinking?.levels !== undefined ? { thinking: { levels: model.thinking.levels } } : {}),
      })),
    }))
}

/** Maps gemini-api-key entries onto the cla2gem facade shape. */
export function geminiCredentialsForMessages(config: NormalizedConfig): readonly cla2gem.Cla2GemCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'gemini-api-key')
    .map((provider) => ({
      apiKey: provider.apiKey,
      ...(provider.baseUrl.length > 0 ? { baseUrl: provider.baseUrl } : {}),
      models: provider.models.map((model) => ({
        name: model.name,
        ...(model.alias !== model.name ? { alias: model.alias } : {}),
        ...(model.thinking === undefined
          ? {}
          : { thinking: model.thinking as { min?: number; max?: number; levels?: readonly string[] } }),
      })),
    }))
}

/** Maps claude-api-key entries onto the gem2cla facade shape. */
export function claudeCredentialsForGemini(config: NormalizedConfig): readonly gem2cla.Gem2ClaCredential[] {
  return config.providers
    .filter((provider): provider is ProviderEntry => provider.family === 'claude-api-key')
    .map((provider) => ({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      models: provider.models.map((model) => ({
        name: model.name,
        alias: model.alias,
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
      })),
    }))
}

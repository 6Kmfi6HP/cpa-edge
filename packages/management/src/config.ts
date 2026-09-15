/**
 * Effective config model: load pipeline (defaults, unmarshal, sanitize,
 * validate, R-BCRYPT), the 47-key JSON view of `GET /config`, and the
 * provider-entry shapes shared by the list endpoints.
 */

import type { JsonValue } from '@cpa-edge/core'
import { blockToValue, parseYamlDoc, type BlockNode } from './yaml'
import { ordered, type OrderedObject, type WireValue } from './gojson'

/** One model alias inside a provider entry. */
export interface ModelAlias {
  name: string
  alias: string
  displayName?: string
  maxContextLength?: number
  forceMapping?: boolean
  isCompat?: boolean
  thinking?: JsonValue
  raw: { readonly [key: string]: JsonValue }
}

/** Fields common to every api-key credential entry. */
export interface ProviderEntry {
  apiKey: string
  baseUrl?: string
  proxyUrl?: string
  prefix?: string
  priority?: number
  weight?: number
  models: readonly ModelAlias[]
  headers?: { readonly [key: string]: JsonValue }
  excludedModels?: readonly string[]
  disableCooling?: boolean
  requestRetry?: number
  requestScopedErrors?: JsonValue
  websockets?: boolean
  alphaSearch?: boolean
  rebuildMidSystemMessage?: boolean
  cloak?: JsonValue
  fingerprintProfile?: string
  experimentalCchSigning?: boolean
  /** openai-compatibility only. */
  name?: string
  disabled?: boolean
  apiKeyEntries?: readonly ApiKeyEntry[]
  supportPromptCacheKey?: boolean
  raw: { readonly [key: string]: JsonValue }
}

/** One `api-key-entries` member of an openai-compatibility provider. */
export interface ApiKeyEntry {
  apiKey: string
  weight?: number
  proxyUrl?: string
  raw: { readonly [key: string]: JsonValue }
}

export interface RoutingConfig {
  strategy: string
  sessionAffinity?: boolean
  sessionAffinityTtl?: string
  sessionAffinitySubagents?: boolean
}

export interface EffectiveConfig {
  host: string
  port: number
  authDir: string
  remoteManagement: { allowRemote: boolean; secretKey: string; disableControlPanel: boolean }
  apiKeys: readonly string[]
  debug: boolean
  requestRetry: number
  maxRetryCredentials: number
  maxRetryInterval: number
  transientErrorCooldownSeconds: number
  authAutoRefreshWorkers: number
  usageStatisticsEnabled: boolean
  loggingToFile: boolean
  logsMaxTotalSizeMb: number
  errorLogsMaxFiles: number
  requestLog: boolean
  wsAuth: boolean
  forceModelPrefix: boolean
  proxyUrl: string
  passthroughHeaders: boolean
  disableImageGeneration: JsonValue
  disableCooling: boolean
  saveCooldownStatus: boolean
  redisUsageQueueRetentionSeconds: number
  quotaExceeded: { switchProject: boolean; switchPreviewModel: boolean; antigravityCredits: boolean }
  routing: RoutingConfig
  commercialMode: boolean
  plugins: { enabled: boolean; dir: string; configs: { readonly [key: string]: JsonValue } }
  gemini: readonly ProviderEntry[]
  interactions: readonly ProviderEntry[]
  claude: readonly ProviderEntry[]
  codex: readonly ProviderEntry[]
  xai: readonly ProviderEntry[]
  meta: readonly ProviderEntry[]
  vertex: readonly ProviderEntry[]
  openaiCompatibility: readonly ProviderEntry[]
  oauthExcludedModels: { readonly [provider: string]: readonly string[] }
  oauthModelAlias: { readonly [channel: string]: JsonValue }
  oauthRequestScopedErrors: { readonly [channel: string]: JsonValue }
  claudeCode: { disableCloakingModelList: boolean }
  claudeHeaderDefaults: { userAgent: string; packageVersion: string; runtimeVersion: string; os: string; arch: string; timeout: string; timezone: string }
  codexHeaderDefaults: { userAgent: string; betaFeatures: string }
  codex: { readonly [key: string]: JsonValue }
  xai: { injectXSearch: boolean }
  streaming: { readonly [key: string]: JsonValue }
  tls: { enable: boolean; cert: string; key: string }
  payload: { readonly [key: string]: JsonValue }
  devin: { readonly [key: string]: JsonValue }
  antigravity: { readonly [key: string]: JsonValue }
  discovery: { readonly [key: string]: JsonValue }
  pprof: { enable: boolean; addr: string }
  raw: { readonly [key: string]: JsonValue }
}

function recordOf(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return { ...(value as { [key: string]: JsonValue }) }
}

function listOf(value: JsonValue | undefined): readonly JsonValue[] {
  if (value === undefined || !Array.isArray(value)) return []
  return value
}

function stringOf(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function intOf(value: JsonValue | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function boolOf(value: JsonValue | undefined, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Normalizes one alias entry (alias defaults to the model name). */
function parseModelAlias(value: JsonValue): ModelAlias | undefined {
  const record = recordOf(value)
  const name = stringOf(record['name'])
  if (name === '') return undefined
  const rawAlias = record['alias']
  const alias = typeof rawAlias === 'string' && rawAlias !== '' ? rawAlias : name
  const displayName = record['display-name']
  const maxContext = record['max-context-length']
  const forceMapping = record['force-mapping']
  const isCompat = record['is-compat']
  const thinking = record['thinking']
  return {
    name,
    alias,
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(typeof maxContext === 'number' ? { maxContextLength: maxContext } : {}),
    ...(typeof forceMapping === 'boolean' ? { forceMapping } : {}),
    ...(typeof isCompat === 'boolean' ? { isCompat } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    raw: record,
  }
}

function parseModels(value: JsonValue | undefined): readonly ModelAlias[] {
  const out: ModelAlias[] = []
  for (const item of listOf(value)) {
    const alias = parseModelAlias(item)
    if (alias !== undefined) out.push(alias)
  }
  return out
}

/** Parses and sanitizes one provider entry (shared field handling). */
function parseProviderEntry(value: JsonValue): ProviderEntry | undefined {
  const record = recordOf(value)
  const apiKey = stringOf(record['api-key'])
  const baseUrlRaw = record['base-url']
  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw : undefined
  const models = parseModels(record['models'])
  const headers = record['headers']
  const excluded = listOf(record['excluded-models']).filter((item): item is string => typeof item === 'string')
  const weight = record['weight']
  const priority = record['priority']
  const prefixRaw = stringOf(record['prefix'])
  const prefix = prefixRaw.includes('/') ? '' : prefixRaw.replace(/^\//, '')
  const proxyUrl = stringOf(record['proxy-url'])
  const disableCooling = record['disable-cooling']
  const requestRetry = record['request-retry']
  const requestScopedErrors = record['request-scoped-errors']
  return {
    apiKey,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(proxyUrl === '' ? {} : { proxyUrl }),
    ...(prefix === '' ? {} : { prefix }),
    ...(typeof priority === 'number' ? { priority } : {}),
    ...(typeof weight === 'number' ? { weight } : {}),
    models,
    ...(headers === undefined ? {} : { headers: recordOf(headers) }),
    ...(excluded.length === 0 ? {} : { excludedModels: excluded }),
    ...(typeof disableCooling === 'boolean' ? { disableCooling } : {}),
    ...(typeof requestRetry === 'number' ? { requestRetry } : {}),
    ...(requestScopedErrors === undefined ? {} : { requestScopedErrors }),
    raw: record,
  }
}

function parseApiKeyEntries(value: JsonValue | undefined): readonly ApiKeyEntry[] {
  const out: ApiKeyEntry[] = []
  for (const item of listOf(value)) {
    const record = recordOf(item)
    const apiKey = stringOf(record['api-key'])
    if (apiKey === '') continue
    const weight = record['weight']
    const proxyUrl = stringOf(record['proxy-url'])
    out.push({
      apiKey,
      ...(typeof weight === 'number' ? { weight } : {}),
      ...(proxyUrl === '' ? {} : { proxyUrl }),
      raw: record,
    })
  }
  return out
}

/** gemini / interactions sanitize: drop fully empty entries, dedupe. */
function sanitizeGeminiLike(entries: readonly JsonValue[]): readonly ProviderEntry[] {
  const seen = new Set<string>()
  const out: ProviderEntry[] = []
  for (const item of entries) {
    const entry = parseProviderEntry(item)
    if (entry === undefined) continue
    if (entry.apiKey === '' && (entry.baseUrl ?? '') === '') continue
    const headers = entry.headers ?? {}
    const headerKey = Object.keys(headers)
      .sort()
      .map((key) => `${key}=${String(headers[key] ?? '')}`)
      .join('&')
    const dedupe = `${entry.apiKey}|${entry.baseUrl ?? ''}|${entry.proxyUrl ?? ''}|${entry.prefix ?? ''}|${headerKey}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push(entry)
  }
  return out
}

/** codex / xai sanitize: entries without base-url are dropped. */
function sanitizeCodexLike(entries: readonly JsonValue[]): readonly ProviderEntry[] {
  const out: ProviderEntry[] = []
  for (const item of entries) {
    const entry = parseProviderEntry(item)
    if (entry === undefined) continue
    if ((entry.baseUrl ?? '') === '') continue
    out.push(entry)
  }
  return out
}

function sanitizeMeta(entries: readonly JsonValue[]): readonly ProviderEntry[] {
  const out: ProviderEntry[] = []
  for (const item of entries) {
    const record = recordOf(item)
    const apiKey = stringOf(record['api-key'])
    if (apiKey === '' || apiKey.startsWith('dca:')) continue
    const entry = parseProviderEntry(item)
    if (entry === undefined) continue
    out.push({ ...entry, baseUrl: (entry.baseUrl ?? '') === '' ? 'https://api.meta.ai/v1' : entry.baseUrl })
  }
  return out
}

function sanitizeOpenAiCompatibility(entries: readonly JsonValue[]): readonly ProviderEntry[] {
  const out: ProviderEntry[] = []
  for (const item of entries) {
    const entry = parseProviderEntry(item)
    if (entry === undefined) continue
    const baseUrl = entry.baseUrl ?? ''
    if (baseUrl === '') continue
    const name = stringOf(entry.raw['name'])
    const supportPromptCacheKey = entry.raw['support-prompt-cache-key']
    out.push({
      ...entry,
      name,
      disabled: boolOf(entry.raw['disabled']),
      ...(typeof supportPromptCacheKey === 'boolean' ? { supportPromptCacheKey } : {}),
      apiKeyEntries: parseApiKeyEntries(entry.raw['api-key-entries']),
    })
  }
  return out
}

function sanitizeVertex(entries: readonly JsonValue[]): readonly ProviderEntry[] {
  const out: ProviderEntry[] = []
  for (const item of entries) {
    const entry = parseProviderEntry(item)
    if (entry === undefined) continue
    out.push(entry)
  }
  return out
}

function sanitizeClaude(entries: readonly JsonValue[]): readonly ProviderEntry[] {
  const out: ProviderEntry[] = []
  for (const item of entries) {
    const entry = parseProviderEntry(item)
    if (entry === undefined) continue
    const fingerprint = entry.raw['fingerprint-profile']
    const cloak = entry.raw['cloak']
    const rebuild = entry.raw['rebuild-mid-system-message']
    const signing = entry.raw['experimental-cch-signing']
    out.push({
      ...entry,
      ...(typeof fingerprint === 'string' ? { fingerprintProfile: fingerprint } : {}),
      ...(cloak !== undefined ? { cloak } : {}),
      ...(typeof rebuild === 'boolean' ? { rebuildMidSystemMessage: rebuild } : {}),
      ...(typeof signing === 'boolean' ? { experimentalCchSigning: signing } : {}),
    })
  }
  return out
}

/** Validation error with the index-scoped message shape of the reference. */
export class ConfigValidationError extends Error {}

const MAX_WEIGHT = 1_000_000

function validateWeights(path: string, entries: readonly ProviderEntry[]): void {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry === undefined) continue
    const weight = entry.weight
    if (weight !== undefined && weight > MAX_WEIGHT) {
      throw new ConfigValidationError(`${path}[${i}].weight: weight must not exceed 1000000`)
    }
  }
}

function validateCredentialInFlight(value: JsonValue | undefined): void {
  const record = recordOf(value)
  if (Object.keys(record).length === 0) return
  const snapshot = stringOf(record['snapshot-interval'], '2s')
  const stale = stringOf(record['stale-after'], '10s')
  const snapshotMs = parseDurationMs(snapshot)
  const staleMs = parseDurationMs(stale)
  if (snapshotMs <= 0) {
    throw new ConfigValidationError('credential-in-flight.snapshot-interval must be greater than zero')
  }
  if (staleMs < 3 * snapshotMs) {
    throw new ConfigValidationError('credential-in-flight.stale-after must be at least three snapshot intervals')
  }
}

/** Go-style duration parse (subset: `30m`, `2h30m`, `250ms`, `1m`). */
export function parseDurationMs(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(text.trim())
  if (match === null) return 0
  const value = Number(match[1])
  switch (match[2]) {
    case 'ns':
      return value / 1_000_000
    case 'us':
    case 'µs':
      return value / 1_000
    case 'ms':
      return value
    case 's':
      return value * 1000
    case 'm':
      return value * 60_000
    case 'h':
      return value * 3_600_000
    default:
      return 0
  }
}

/**
 * Parses a `credential-in-flight` block missing from user YAML: defaults
 * come from the reference struct, so `GET /config` shows them even when the
 * file never mentioned them.
 */
const DEFAULT_CREDENTIAL_IN_FLIGHT: { readonly [key: string]: WireValue } = {
  'snapshot-interval': '2s',
  'stale-after': '10s',
  'max-part-bytes': 262144,
  'max-part-count': 64,
  'max-revision-bytes': 16777216,
  'max-aggregate-groups': 100000,
  'max-details': 10000,
  'max-string-bytes': 256,
  'staging-retention': '1m',
}

const DEFAULT_CREDENTIAL_CONCURRENCY: { readonly [key: string]: WireValue } = {
  'lifecycle-config-revision': 0,
  'observation-barrier-revision': 0,
  'cpa-heartbeat-timeout': 3000000000,
  'cpa-cancel-bound': 5000000000,
  'reclaim-grace': 5000000000,
  'cleanup-interval': 5000000000,
  'release-flush-interval': 250000000,
  'release-max-backoff': 2000000000,
  'busy-retry-min': 250000000,
  'busy-retry-max': 1000000000,
  'max-limit': 1000000,
}

const DEFAULT_DISCOVERY: { readonly [key: string]: WireValue } = {
  enabled: false,
  'service-name': '',
  'service-type': '_ai-gateway._tcp',
  subtypes: ['_chat-completions', '_responses', '_messages', '_generate-content', '_interactions'],
  interfaces: { include: null, exclude: null },
  'auth-required': null,
  'advertise-management': false,
}

const DEFAULT_ROUTING_SUBTYPES = DEFAULT_DISCOVERY['subtypes'] as WireValue

/** Normalizes a routing strategy with the reference alias table. */
export function normalizeStrategy(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase()
  switch (trimmed) {
    case 'round-robin':
    case 'roundrobin':
    case 'rr':
      return 'round-robin'
    case 'weighted-round-robin':
    case 'weightedroundrobin':
    case 'wrr':
      return 'weighted-round-robin'
    case 'fill-first':
    case 'fillfirst':
    case 'ff':
      return 'fill-first'
    default:
      return undefined
  }
}

/**
 * Full load pipeline minus persistence: YAML unmarshal, per-key defaults,
 * sanitization and validation. Throws `YamlError` / `ConfigValidationError`
 * for the `invalid_yaml` / `invalid_config` ladders.
 */
export function loadEffectiveConfig(yamlText: string, doc?: BlockNode): EffectiveConfig {
  const parsed = doc ?? parseYamlDoc(yamlText)
  const root = recordOf(blockToValue(parsed))
  const remote = recordOf(root['remote-management'])
  const routing = recordOf(root['routing'])
  const plugins = recordOf(root['plugins'])
  const quota = recordOf(root['quota-exceeded'])
  const strategyRaw = stringOf(routing['strategy'], 'round-robin')
  const strategy = normalizeStrategy(strategyRaw) ?? 'round-robin'
  const rawRetention = intOf(root['redis-usage-queue-retention-seconds'], 60)
  const logsMax = intOf(root['logs-max-total-size-mb'], 0)
  const errorLogs = intOf(root['error-logs-max-files'], 10)

  const gemini = sanitizeGeminiLike(listOf(root['gemini-api-key']))
  const interactions = sanitizeGeminiLike(listOf(root['interactions-api-key']))
  const codex = sanitizeCodexLike(listOf(root['codex-api-key']))
  const xai = sanitizeCodexLike(listOf(root['xai-api-key']))
  const meta = sanitizeMeta(listOf(root['meta-api-key']))
  const claude = sanitizeClaude(listOf(root['claude-api-key']))
  const vertex = sanitizeVertex(listOf(root['vertex-api-key']))
  const openaiCompatibility = sanitizeOpenAiCompatibility(listOf(root['openai-compatibility']))

  validateWeights('gemini-api-key', gemini)
  validateWeights('interactions-api-key', interactions)
  validateWeights('codex-api-key', codex)
  validateWeights('xai-api-key', xai)
  validateWeights('meta-api-key', meta)
  validateWeights('claude-api-key', claude)
  validateWeights('vertex-api-key', vertex)
  for (let i = 0; i < openaiCompatibility.length; i += 1) {
    const entry = openaiCompatibility[i]
    if (entry === undefined) continue
    const weight = entry.weight
    if (weight !== undefined && weight > MAX_WEIGHT) {
      throw new ConfigValidationError(`openai-compatibility[${i}].weight: weight must not exceed 1000000`)
    }
    for (let j = 0; j < (entry.apiKeyEntries ?? []).length; j += 1) {
      const sub = entry.apiKeyEntries?.[j]
      if (sub === undefined) continue
      if (sub.weight !== undefined && sub.weight > MAX_WEIGHT) {
        throw new ConfigValidationError(`openai-compatibility[${i}].api-key-entries[${j}].weight: weight must not exceed 1000000`)
      }
    }
  }
  validateCredentialInFlight(root['credential-in-flight'])

  const oauthExcluded: { [provider: string]: readonly string[] } = {}
  const excludedRaw = recordOf(root['oauth-excluded-models'])
  for (const [provider, models] of Object.entries(excludedRaw)) {
    const key = provider.trim().toLowerCase()
    if (key === '') continue
    const list = listOf(models).filter((item): item is string => typeof item === 'string')
    if (list.length === 0) continue
    oauthExcluded[key] = list
  }
  const modelAliasRaw = recordOf(root['oauth-model-alias'])
  const scopedErrorsRaw = recordOf(root['oauth-request-scoped-errors'])

  return {
    host: stringOf(root['host']),
    port: intOf(root['port'], 0),
    authDir: stringOf(root['auth-dir'], '~/.cli-proxy-api'),
    remoteManagement: {
      allowRemote: boolOf(remote['allow-remote']),
      secretKey: stringOf(remote['secret-key']),
      disableControlPanel: boolOf(remote['disable-control-panel']),
    },
    apiKeys: listOf(root['api-keys']).filter((item): item is string => typeof item === 'string'),
    debug: boolOf(root['debug']),
    requestRetry: intOf(root['request-retry'], 0),
    maxRetryCredentials: Math.max(0, intOf(root['max-retry-credentials'], 0)),
    maxRetryInterval: intOf(root['max-retry-interval'], 0),
    transientErrorCooldownSeconds: intOf(root['transient-error-cooldown-seconds'], 0),
    authAutoRefreshWorkers: intOf(root['auth-auto-refresh-workers'], 0),
    usageStatisticsEnabled: boolOf(root['usage-statistics-enabled']),
    loggingToFile: boolOf(root['logging-to-file']),
    logsMaxTotalSizeMb: logsMax < 0 ? 0 : logsMax,
    errorLogsMaxFiles: errorLogs < 0 ? 10 : errorLogs,
    requestLog: boolOf(root['request-log']),
    wsAuth: boolOf(root['ws-auth'], true),
    forceModelPrefix: boolOf(root['force-model-prefix']),
    proxyUrl: stringOf(root['proxy-url']),
    passthroughHeaders: boolOf(root['passthrough-headers']),
    disableImageGeneration: root['disable-image-generation'] ?? false,
    disableCooling: boolOf(root['disable-cooling']),
    saveCooldownStatus: boolOf(root['save-cooldown-status']),
    redisUsageQueueRetentionSeconds: rawRetention <= 0 ? 60 : Math.min(rawRetention, 3600),
    quotaExceeded: {
      switchProject: boolOf(quota['switch-project']),
      switchPreviewModel: boolOf(quota['switch-preview-model']),
      antigravityCredits: boolOf(quota['antigravity-credits']),
    },
    routing: {
      strategy,
      ...(typeof routing['session-affinity'] === 'boolean' ? { sessionAffinity: routing['session-affinity'] as boolean } : {}),
      ...(typeof routing['session-affinity-ttl'] === 'string' ? { sessionAffinityTtl: routing['session-affinity-ttl'] as string } : {}),
      ...(typeof routing['session-affinity-subagents'] === 'boolean' ? { sessionAffinitySubagents: routing['session-affinity-subagents'] as boolean } : {}),
    },
    commercialMode: boolOf(root['commercial-mode']),
    plugins: {
      enabled: boolOf(plugins['enabled']),
      dir: stringOf(plugins['dir'], 'plugins'),
      configs: recordOf(plugins['configs']),
    },
    gemini,
    interactions,
    claude,
    codex,
    xai,
    meta,
    vertex,
    openaiCompatibility,
    oauthExcludedModels: oauthExcluded,
    oauthModelAlias: modelAliasRaw,
    oauthRequestScopedErrors: scopedErrorsRaw,
    claudeCode: { disableCloakingModelList: boolOf(recordOf(root['claude-code'])['disable-cloaking-model-list']) },
    claudeHeaderDefaults: readHeaderDefaults(recordOf(root['claude-header-defaults'])),
    codexHeaderDefaults: {
      userAgent: stringOf(recordOf(root['codex-header-defaults'])['user-agent']),
      betaFeatures: stringOf(recordOf(root['codex-header-defaults'])['beta-features']),
    },
    codex: recordOf(root['codex']),
    xai: { injectXSearch: boolOf(recordOf(root['xai'])['inject-x-search']) },
    streaming: recordOf(root['streaming']),
    tls: {
      enable: boolOf(recordOf(root['tls'])['enable']),
      cert: stringOf(recordOf(root['tls'])['cert']),
      key: stringOf(recordOf(root['tls'])['key']),
    },
    payload: recordOf(root['payload']),
    devin: recordOf(root['devin']),
    antigravity: recordOf(root['antigravity']),
    discovery: recordOf(root['discovery']),
    pprof: {
      enable: boolOf(recordOf(root['pprof'])['enable']),
      addr: stringOf(recordOf(root['pprof'])['addr'], '127.0.0.1:8316'),
    },
    raw: root,
  }
}

function readHeaderDefaults(record: { [key: string]: JsonValue }): EffectiveConfig['claudeHeaderDefaults'] {
  return {
    userAgent: stringOf(record['user-agent']),
    packageVersion: stringOf(record['package-version']),
    runtimeVersion: stringOf(record['runtime-version']),
    os: stringOf(record['os']),
    arch: stringOf(record['arch']),
    timeout: stringOf(record['timeout']),
    timezone: stringOf(record['timezone']),
  }
}

// ---------------------------------------------------------------------------
// Serialization shapes
// ---------------------------------------------------------------------------

function modelWire(alias: ModelAlias): OrderedObject {
  const object = ordered([['name', alias.alias === '' ? alias.name : alias.name], ['alias', alias.alias]])
  void object
  const members: Array<[string, WireValue]> = [['name', alias.name], ['alias', alias.alias]]
  if (alias.displayName !== undefined) members.push(['display-name', alias.displayName])
  if (alias.maxContextLength !== undefined) members.push(['max-context-length', alias.maxContextLength])
  if (alias.forceMapping !== undefined) members.push(['force-mapping', alias.forceMapping])
  if (alias.isCompat !== undefined) members.push(['is-compat', alias.isCompat])
  if (alias.thinking !== undefined) members.push(['thinking', alias.thinking])
  return ordered(members)
}

/** True for families whose `proxy-url` serializes even when empty. */
const PROXY_URL_ALWAYS = new Set(['claude', 'codex', 'xai', 'meta'])

/**
 * Serializes one provider entry in struct order. `family` selects the
 * struct-specific quirks (proxy-url presence, extra fields); `withAuthIndex`
 * appends the runtime credential index to single-key families.
 */
export function providerEntryWire(
  entry: ProviderEntry,
  family: 'gemini' | 'interactions' | 'claude' | 'codex' | 'xai' | 'meta' | 'vertex' | 'openai-compatibility',
  extra?: ReadonlyArray<[string, WireValue]>,
): OrderedObject {
  const members: Array<[string, WireValue]> = []
  if (family === 'openai-compatibility') {
    members.push(['name', entry.name ?? ''])
    members.push(['disabled', entry.disabled === true])
    if (entry.priority !== undefined) members.push(['priority', entry.priority])
    if (entry.prefix !== undefined) members.push(['prefix', entry.prefix])
    members.push(['base-url', entry.baseUrl ?? ''])
    if ((entry.apiKeyEntries ?? []).length > 0) {
      members.push([
        'api-key-entries',
        (entry.apiKeyEntries ?? []).map((sub) => {
          const subMembers: Array<[string, WireValue]> = [['api-key', sub.apiKey]]
          if (sub.weight !== undefined) subMembers.push(['weight', sub.weight])
          if (sub.proxyUrl !== undefined) subMembers.push(['proxy-url', sub.proxyUrl])
          return ordered(subMembers)
        }),
      ])
    }
    members.push(['models', entry.models.map(modelWire)])
    return ordered(members)
  }
  members.push(['api-key', entry.apiKey])
  if (entry.priority !== undefined) members.push(['priority', entry.priority])
  if (entry.weight !== undefined) members.push(['weight', entry.weight])
  if (entry.prefix !== undefined) members.push(['prefix', entry.prefix])
  if (entry.baseUrl !== undefined) members.push(['base-url', entry.baseUrl])
  if (entry.proxyUrl !== undefined || PROXY_URL_ALWAYS.has(family)) {
    members.push(['proxy-url', entry.proxyUrl ?? ''])
  }
  if (entry.models.length > 0) members.push(['models', entry.models.map(modelWire)])
  if (entry.headers !== undefined && Object.keys(entry.headers).length > 0) {
    members.push(['headers', entry.headers])
  }
  if ((entry.excludedModels ?? []).length > 0) members.push(['excluded-models', [...(entry.excludedModels ?? [])]])
  if (entry.disableCooling !== undefined) members.push(['disable-cooling', entry.disableCooling])
  if (entry.requestRetry !== undefined) members.push(['request-retry', entry.requestRetry])
  if (entry.requestScopedErrors !== undefined) members.push(['request-scoped-errors', entry.requestScopedErrors])
  if (family === 'claude') {
    if (entry.rebuildMidSystemMessage !== undefined) members.push(['rebuild-mid-system-message', entry.rebuildMidSystemMessage])
    if (entry.cloak !== undefined) members.push(['cloak', entry.cloak])
    if (entry.fingerprintProfile !== undefined) members.push(['fingerprint-profile', entry.fingerprintProfile])
    if (entry.experimentalCchSigning !== undefined) members.push(['experimental-cch-signing', entry.experimentalCchSigning])
  }
  if (family === 'codex') {
    if (entry.alphaSearch !== undefined) members.push(['alpha-search', entry.alphaSearch])
  }
  if (family === 'xai') {
    if (entry.websockets !== undefined) members.push(['websockets', entry.websockets])
    if (entry.alphaSearch !== undefined) members.push(['alpha-search', entry.alphaSearch])
  }
  if (extra !== undefined) members.push(...extra)
  return ordered(members)
}

/** The full effective-config view (`GET /config`), the recorded 47-key shape. */
export function configViewWire(config: EffectiveConfig): OrderedObject {
  const providerList = (entries: readonly ProviderEntry[], family: Parameters<typeof providerEntryWire>[1]): WireValue =>
    entries.length === 0 ? null : entries.map((entry) => providerEntryWire(entry, family))

  const routingMembers: Array<[string, WireValue]> = []
  if (config.routing.strategy !== '' && config.routing.strategy !== 'round-robin') {
    routingMembers.push(['strategy', config.routing.strategy])
  }
  if (config.routing.sessionAffinity !== undefined) routingMembers.push(['session-affinity', config.routing.sessionAffinity])
  if (config.routing.sessionAffinityTtl !== undefined) routingMembers.push(['session-affinity-ttl', config.routing.sessionAffinityTtl])
  if (config.routing.sessionAffinitySubagents !== undefined) routingMembers.push(['session-affinity-subagents', config.routing.sessionAffinitySubagents])

  const discovery = { ...DEFAULT_DISCOVERY, ...config.discovery }
  if (discovery['subtypes'] === undefined) discovery['subtypes'] = DEFAULT_ROUTING_SUBTYPES

  const payloadMembers: Array<[string, WireValue]> = [
    ['default', config.payload['default'] ?? null],
    ['default-raw', config.payload['default-raw'] ?? null],
    ['override', config.payload['override'] ?? null],
    ['override-raw', config.payload['override-raw'] ?? null],
    ['filter', config.payload['filter'] ?? null],
  ]

  return ordered([
    ['proxy-url', config.proxyUrl],
    ['disable-image-generation', config.disableImageGeneration],
    ['force-model-prefix', config.forceModelPrefix],
    ['request-log', config.requestLog],
    ['claude-code', ordered([['disable-cloaking-model-list', config.claudeCode.disableCloakingModelList]])],
    ['api-keys', [...config.apiKeys]],
    ['passthrough-headers', config.passthroughHeaders],
    ['streaming', Object.keys(config.streaming).length === 0 ? {} : config.streaming],
    ['tls', ordered([['enable', config.tls.enable], ['cert', config.tls.cert], ['key', config.tls.key]])],
    ['credential-concurrency', { ...DEFAULT_CREDENTIAL_CONCURRENCY, ...recordOf(config.raw['credential-concurrency']) }],
    ['credential-in-flight', { ...DEFAULT_CREDENTIAL_IN_FLIGHT, ...recordOf(config.raw['credential-in-flight']) }],
    ['plugins', ordered([
      ['enabled', config.plugins.enabled],
      ['dir', config.plugins.dir],
      ['configs', config.plugins.configs],
    ])],
    ['debug', config.debug],
    ['pprof', ordered([['enable', config.pprof.enable], ['addr', config.pprof.addr]])],
    ['discovery', discovery],
    ['commercial-mode', config.commercialMode],
    ['logging-to-file', config.loggingToFile],
    ['logs-max-total-size-mb', config.logsMaxTotalSizeMb],
    ['error-logs-max-files', config.errorLogsMaxFiles],
    ['usage-statistics-enabled', config.usageStatisticsEnabled],
    ['redis-usage-queue-retention-seconds', config.redisUsageQueueRetentionSeconds],
    ['disable-cooling', config.disableCooling],
    ['save-cooldown-status', config.saveCooldownStatus],
    ['transient-error-cooldown-seconds', config.transientErrorCooldownSeconds],
    ['auth-auto-refresh-workers', config.authAutoRefreshWorkers],
    ['request-retry', config.requestRetry],
    ['max-retry-credentials', config.maxRetryCredentials],
    ['max-retry-interval', config.maxRetryInterval],
    ['quota-exceeded', ordered([
      ['switch-project', config.quotaExceeded.switchProject],
      ['switch-preview-model', config.quotaExceeded.switchPreviewModel],
      ['antigravity-credits', config.quotaExceeded.antigravityCredits],
    ])],
    ['routing', ordered(routingMembers)],
    ['ws-auth', config.wsAuth],
    ['antigravity', Object.keys(config.antigravity).length === 0 ? { 'connection-pool': {} } : config.antigravity],
    ['devin', Object.keys(config.devin).length === 0 ? {} : config.devin],
    ['gemini-api-key', providerList(config.gemini, 'gemini')],
    ['interactions-api-key', providerList(config.interactions, 'interactions')],
    ['codex-api-key', providerList(config.codex, 'codex')],
    ['xai-api-key', providerList(config.xai, 'xai')],
    ['meta-api-key', providerList(config.meta, 'meta')],
    ['xai', ordered([['inject-x-search', config.xai.injectXSearch]])],
    ['codex', codexView(config.codex)],
    ['codex-header-defaults', ordered([['user-agent', config.codexHeaderDefaults.userAgent], ['beta-features', config.codexHeaderDefaults.betaFeatures]])],
    ['claude-api-key', providerList(config.claude, 'claude')],
    ['claude-header-defaults', ordered([
      ['user-agent', config.claudeHeaderDefaults.userAgent],
      ['package-version', config.claudeHeaderDefaults.packageVersion],
      ['runtime-version', config.claudeHeaderDefaults.runtimeVersion],
      ['os', config.claudeHeaderDefaults.os],
      ['arch', config.claudeHeaderDefaults.arch],
      ['timeout', config.claudeHeaderDefaults.timeout],
      ['timezone', config.claudeHeaderDefaults.timezone],
    ])],
    ['disable-claude-cloak-mode', boolOf(config.raw['disable-claude-cloak-mode'])],
    ['openai-compatibility', providerList(config.openaiCompatibility, 'openai-compatibility')],
    ['vertex-api-key', providerList(config.vertex, 'vertex')],
    ['payload', ordered(payloadMembers)],
  ])
}

/** Codex block with its recorded defaults filled in. */
function codexView(record: { readonly [key: string]: JsonValue }): WireValue {
  const defaults: { readonly [key: string]: WireValue } = {
    'identity-confuse': false,
    'disable-codex-cloaking': false,
    'stream-bootstrap-buffering': false,
    'optimize-multi-agent-v2': false,
    'orphan-delegation-compatibility': false,
    'model-level-cooling': false,
    'live-media-relay': {
      enabled: false,
      'max-sessions': 0,
      'disable-private-remote-ips': false,
      'public-ip': '',
      'udp-port-min': 0,
      'udp-port-max': 0,
      'ice-servers': null,
    },
  }
  const out: { [key: string]: WireValue } = {}
  for (const [key, value] of Object.entries(defaults)) {
    out[key] = record[key] ?? value
  }
  for (const [key, value] of Object.entries(record)) {
    if (!(key in out)) out[key] = value
  }
  return out
}

/** Serializes provider entries back to raw YAML-shaped JSON (for persistence). */
export function providerEntryToRawJson(entry: ProviderEntry): { [key: string]: JsonValue } {
  return entry.raw
}

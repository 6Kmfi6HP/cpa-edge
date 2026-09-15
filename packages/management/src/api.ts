
/**
 * The `/v0/management` adapter: route surface (S5), state-layer operations
 * (S6) and the composed auth plane. Everything stateful flows through the
 * injected Store; the clock, build identity, upstream transport and
 * auth-index derivation are injectable.
 */

import type { JsonValue, Store } from '@cpa-edge/core'
import { deriveAuthIndex } from '@cpa-edge/core'
import {
  createAuthPlane,
  prepareManagementSecretSync,
  looksLikeBcrypt,
  type AuthPlane,
} from '@cpa-edge/auth'
import { goJson, ordered, type OrderedObject, type WireValue, parseJsonGo, asPlainRecord } from './gojson'
import { YamlFileEditor, YamlError, renderScalar, renderSequence } from './yaml'
import {
  configViewWire,
  loadEffectiveConfig,
  normalizeStrategy,
  providerEntryWire,
  ConfigValidationError,
  type EffectiveConfig,
  type ProviderEntry,
  type ApiKeyEntry,
} from './config'
import { AuthFileRegistry, applyFieldPatch, checkAuthFileName, vertexFileName, FieldPatchError } from './authfiles'
import { reEncodePrivateKey, ServiceAccountError } from './vertex'
import { CooldownSidecars } from './cooldown'
import { appendLogRing, buildCursor, decodeCursor, formatRingLine, lineTimestampSeconds, readLogRing, stampFor } from './logs'
import {
  popUsageRecords,
  recentRequestBuckets,
  serializeErrorEvent,
  serializeUsageRecord,
  type ErrorEventInput,
  type UsageCompletion,
  USAGE_QUEUE,
} from './usage'
import { openUsageWireConnection, type UsageWireConnection } from './resp'
import { authFileModels, canonicalChannel, channelCatalog } from './catalog'
import { canonicalHeaderKey, localZoneOffsetMinutes, rfc3339Utc } from './wire'

/** Ordered header list attached to every response (canonical casing). */
export type HeaderList = ReadonlyArray<readonly [string, string]>

export type WireResponse = Response & { readonly rawHeaders: HeaderList }

export interface BuildInfo {
  readonly version: string
  readonly commit: string
  readonly buildDate: string
  readonly supportPlugin: boolean
}

export interface ApiCallRequest {
  readonly method: string
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

export interface ApiCallReply {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
}

export type ApiCallSender = (request: ApiCallRequest) => Promise<ApiCallReply>

export interface LogLineEntry {
  readonly line: string
  readonly level: string
  readonly timestamp: string
  readonly requestId: string
}

export interface ManagementApiDeps {
  readonly configYaml: string
  readonly managementKey: string
  readonly store: Store
  readonly buildInfo: BuildInfo
  readonly sendUpstream?: ApiCallSender
  readonly clientIp?: string
  readonly now?: () => number
  readonly initialLogLines?: readonly LogLineEntry[]
  readonly deriveAuthIndex?: (input: { readonly fileName: string; readonly document: JsonValue }) => string
}

export interface CooldownRecord {
  readonly authId: string
  readonly provider: string
  readonly model?: string
  readonly status: string
  readonly nextRetryAfter: string
  readonly reason: string
  readonly lastError: { readonly message: string; readonly retryable: boolean; readonly httpStatus: number }
  readonly quota?: { readonly exceeded: boolean; readonly nextRecoverAt: string; readonly observedAt: string }
}

export interface CooldownSidecar {
  readonly name: string
  readonly authId: string
  readonly content: string
}

export interface ManagementApi {
  handle(request: Request): Promise<WireResponse>
  recordUsage(completion: UsageCompletion): Promise<void>
  publishError(event: ErrorEventInput): Promise<void>
  openUsageWire(): UsageWireConnection
  recordCooldown(record: CooldownRecord): Promise<void>
  listCooldownSidecars(): Promise<ReadonlyArray<CooldownSidecar>>
  isCooling(authId: string, model?: string): Promise<boolean>
  appendLogLine(entry: LogLineEntry): Promise<void>
  readLogRing(): Promise<readonly LogLineEntry[]>
  buildModelList(): Promise<string>
  readConfigFile(): Promise<string>
  replaceConfigFile(yaml: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

const CORS_BLOCK: readonly (readonly [string, string])[] = [
  ['Access-Control-Allow-Headers', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  ['Access-Control-Allow-Origin', '*'],
  [
    'Access-Control-Expose-Headers',
    'X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id',
  ],
]

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** Response payload: status, body bytes, extra headers, header regime. */
export interface ResponsePlan {
  readonly status: number
  readonly body: string | null
  readonly contentType?: string
  readonly extra?: readonly (readonly [string, string])[]
  /** Skip the X-Cpa-* block (the unauthenticated oauth-callback route). */
  readonly noBuildHeaders?: boolean
  /** Skip every handler header (management disabled: bare 404). */
  readonly bare?: boolean
}

/** Serializes one catalog model in the recorded struct field order. */
function catalogModelWire(model: {
  readonly id: string
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
}): OrderedObject {
  const members: Array<[string, WireValue]> = [
    ['id', model.id],
    ['object', 'model'],
    ['created', model.created],
    ['owned_by', model.owned_by],
    ['type', model.type],
    ['display_name', model.display_name],
    ['description', model.description],
    ['context_length', model.context_length],
    ['max_completion_tokens', model.max_completion_tokens],
    ['supportedInputModalities', [...model.supportedInputModalities]],
    ['supportedOutputModalities', [...model.supportedOutputModalities]],
  ]
  if (model.thinking !== undefined) {
    const fields = model.thinking as { [key: string]: unknown }
    const order = Object.keys(fields).sort(
      (left, right) => THINKING_FIELD_ORDER.indexOf(left) - THINKING_FIELD_ORDER.indexOf(right),
    )
    members.push(['thinking', ordered(order.map((key) => [key, fields[key] as WireValue]))])
  }
  return ordered(members)
}

/** Struct order of the thinking block (`zero_allowed` before `levels`). */
const THINKING_FIELD_ORDER: readonly string[] = ['zero_allowed', 'levels']

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Known scalar keys the reference yaml writer omits while zero. */
const OMIT_WHEN_ZERO = new Set(['logs-max-total-size-mb'])

/** Families and paths of the eight provider lists. */
const PROVIDER_LISTS = {
  'gemini-api-key': { family: 'gemini' as const, literal: 'gemini-api-key', key: 'gemini' },
  'interactions-api-key': { family: 'interactions' as const, literal: 'interactions-api-key', key: 'interactions' },
  'claude-api-key': { family: 'claude' as const, literal: 'claude-api-key', key: 'claude' },
  'codex-api-key': { family: 'codex' as const, literal: 'codex-api-key', key: 'codex' },
  'xai-api-key': { family: 'xai' as const, literal: 'xai-api-key', key: 'xai' },
  'meta-api-key': { family: 'meta' as const, literal: 'meta-api-key', key: 'meta' },
  'vertex-api-key': { family: 'vertex' as const, literal: 'vertex-api-key', key: 'vertex' },
  'openai-compatibility': { family: 'openai-compatibility' as const, literal: 'openai-compatibility', key: 'openaiCompatibility' },
}

type ProviderListKey = keyof typeof PROVIDER_LISTS

interface UsageSubscriber {
  readonly channel: 'usage' | 'errors'
  deliver(payload: string): void
}

export function createManagementApi(deps: ManagementApiDeps): ManagementApi {
  const store = deps.store
  const now = deps.now ?? (() => Date.now())
  const clientIp = deps.clientIp ?? '127.0.0.1'
  const zoneOffset = localZoneOffsetMinutes()

  // ---- config file state -------------------------------------------------
  let configText = ''
  let effective!: EffectiveConfig
  let authPlane: AuthPlane

  // ---- live subscribers --------------------------------------------------
  const subscribers = new Set<UsageSubscriber>()

  const buildHeaders = (): readonly (readonly [string, string])[] => [
    ['X-Cpa-Version', deps.buildInfo.version],
    ['X-Cpa-Commit', deps.buildInfo.commit],
    ['X-Cpa-Build-Date', deps.buildInfo.buildDate],
    ['X-Cpa-Support-Plugin', deps.buildInfo.supportPlugin ? '1' : '0'],
  ]

  const respond = (plan: ResponsePlan): WireResponse => {
    if (plan.bare === true) {
      return Object.assign(new Response(null, { status: plan.status }), {
        rawHeaders: [] as HeaderList,
      })
    }
    const headers: Array<[string, string]> = CORS_BLOCK.map(
      ([name, value]) => [name, value] as [string, string],
    )
    if (plan.noBuildHeaders !== true) {
      for (const pair of buildHeaders()) headers.push([pair[0], pair[1]])
    }
    if (plan.body !== null) {
      headers.push(['Content-Type', plan.contentType ?? JSON_CONTENT_TYPE])
    }
    if (plan.extra !== undefined) {
      for (const [name, value] of plan.extra) headers.push([name, value])
    }
    headers.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const response = new Response(plan.body === null ? null : plan.body, {
      status: plan.status,
      headers: headers.map(([name, value]) => [name, value] as [string, string]),
    })
    return Object.assign(response, { rawHeaders: headers as HeaderList })
  }

  const json = (status: number, body: string, plan?: Partial<ResponsePlan>): WireResponse =>
    respond({ status, body, ...plan })

  const ginError = (status: number, message: string): WireResponse => json(status, goJson({ error: message }))

  // ---- load pipeline ------------------------------------------------------
  const normalizeConfigText = (text: string, hashedSecret: string | undefined): string => {
    const editor = new YamlFileEditor(text)
    editor.dropBlankLines()
    if (hashedSecret !== undefined) {
      editor.setScalar(['remote-management'], 'secret-key', hashedSecret)
    }
    const loaded = loadEffectiveConfig(editor.getText())
    if (loaded.logsMaxTotalSizeMb === 0) {
      for (const key of OMIT_WHEN_ZERO) editor.removeKey([], key)
    }
    editor.ensureTrailingNewline()
    return editor.getText()
  }

  const materialize = (yamlText: string): { mutated: boolean } => {
    const parsedSecret = readSecretKey(yamlText)
    let hashedSecret: string | undefined
    let mutated = false
    if (parsedSecret !== undefined && parsedSecret !== '' && !looksLikeBcrypt(parsedSecret)) {
      hashedSecret = prepareManagementSecretSync(parsedSecret).stored
      mutated = true
    }
    configText = normalizeConfigText(yamlText, hashedSecret)
    effective = loadEffectiveConfig(configText)
    authPlane = createAuthPlane(
      {
        port: effective.port,
        apiKeys: [...effective.apiKeys],
        remoteManagement: {
          allowRemote: effective.remoteManagement.allowRemote,
          secretKey: effective.remoteManagement.secretKey,
        },
        authDir: effective.authDir,
      },
      { store, now, remoteAddress: clientIp },
    )
    return { mutated }
  }

  const readSecretKey = (text: string): string | undefined => {
    try {
      const doc = loadEffectiveConfig(text)
      return doc.remoteManagement.secretKey
    } catch {
      return undefined
    }
  }

  const reloadEffective = (): void => {
    effective = loadEffectiveConfig(configText)
  }

  // ---- surgical persistence ----------------------------------------------
  const persistScalar = (key: string, value: JsonValue): void => {
    const editor = new YamlFileEditor(configText)
    editor.setScalar([], key, value)
    editor.ensureTrailingNewline()
    configText = editor.getText()
    reloadEffective()
  }

  const persistNestedScalar = (path: readonly string[], key: string, value: JsonValue): void => {
    const editor = new YamlFileEditor(configText)
    editor.setScalar(path, key, value)
    editor.ensureTrailingNewline()
    configText = editor.getText()
    reloadEffective()
  }

  const persistSequence = (key: string, values: readonly string[]): void => {
    const editor = new YamlFileEditor(configText)
    editor.setBlock([], key, renderSequence(values, true))
    editor.ensureTrailingNewline()
    configText = editor.getText()
    reloadEffective()
  }

  const persistProviderList = (key: string, entries: readonly JsonValue[]): void => {
    const editor = new YamlFileEditor(configText)
    const lines: string[] = []
    for (const entry of entries) {
      const record = (typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {}) as {
        [key: string]: JsonValue
      }
      lines.push(...renderItemMapping(record, 0))
    }
    editor.setBlock([], key, lines)
    editor.ensureTrailingNewline()
    configText = editor.getText()
    reloadEffective()
  }

  /** Renders a plain mapping (`key: value`, nested blocks indented +2). */
  const renderMappingLines = (record: { [key: string]: JsonValue }, indent: number): string[] => {
    const pad = ' '.repeat(indent)
    const lines: string[] = []
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value)) {
        lines.push(`${pad}${key}:`)
        for (const item of value) lines.push(...renderValueItem(item, indent + 2))
        continue
      }
      if (typeof value === 'object' && value !== null) {
        lines.push(`${pad}${key}:`)
        lines.push(...renderMappingLines(value as { [key: string]: JsonValue }, indent + 2))
        continue
      }
      lines.push(`${pad}${key}: ${renderScalar(value)}`)
    }
    return lines
  }

  /** Renders one sequence item: a scalar item or an inline-first-key mapping. */
  const renderValueItem = (item: JsonValue, indent: number): string[] => {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      return renderItemMapping(item as { [key: string]: JsonValue }, indent)
    }
    return [`${' '.repeat(indent)}- ${renderScalar(item)}`]
  }

  /** Renders a sequence-item mapping: dash + first key inline, rest at +2. */
  const renderItemMapping = (record: { [key: string]: JsonValue }, indent: number): string[] => {
    const pad = ' '.repeat(indent)
    const innerPad = ' '.repeat(indent + 2)
    const lines: string[] = []
    const keys = Object.keys(record)
    keys.forEach((key, index) => {
      const value = record[key] ?? null
      const linePad = index === 0 ? pad : innerPad
      if (index === 0) {
        if (Array.isArray(value)) {
          lines.push(`${linePad}- ${key}:`)
          for (const item of value) lines.push(...renderValueItem(item, indent + 4))
        } else if (typeof value === 'object' && value !== null) {
          lines.push(`${linePad}- ${key}:`)
          lines.push(...renderMappingLines(value as { [key: string]: JsonValue }, indent + 4))
        } else {
          lines.push(`${linePad}- ${key}: ${renderScalar(value)}`)
        }
        return
      }
      if (Array.isArray(value)) {
        lines.push(`${linePad}${key}:`)
        for (const item of value) lines.push(...renderValueItem(item, indent + 4))
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${linePad}${key}:`)
        lines.push(...renderMappingLines(value as { [key: string]: JsonValue }, indent + 4))
      } else {
        lines.push(`${linePad}${key}: ${renderScalar(value)}`)
      }
    })
    return lines
  }

  // ---- credential synthesis ----------------------------------------------
  const credentialAuthIndex = async (
    familyLiteral: string,
    baseUrl: string,
    apiKey: string,
  ): Promise<string> => deriveAuthIndex({ familyLiteral, baseUrl, apiKey, authId: `config:${familyLiteral}` })

  const listAuthIndexOf = async (spec: (typeof PROVIDER_LISTS)[ProviderListKey], entry: ProviderEntry): Promise<string | undefined> => {
    if (spec.family === 'openai-compatibility') return undefined
    return credentialAuthIndex(spec.literal, entry.baseUrl ?? '', entry.apiKey)
  }

  const apiKeyEntryAuthIndex = async (baseUrl: string, apiKey: string): Promise<string> =>
    credentialAuthIndex('openai-compatibility', baseUrl, apiKey)

  // ---- auth-file registry -------------------------------------------------
  const deriveFileAuthIndex = (fileName: string, document: JsonValue): string => {
    if (deps.deriveAuthIndex !== undefined) return deps.deriveAuthIndex({ fileName, document })
    const record = (typeof document === 'object' && document !== null && !Array.isArray(document) ? document : {}) as {
      [key: string]: JsonValue
    }
    const type = typeof record['type'] === 'string' ? (record['type'] as string).toLowerCase() : ''
    const path = `${effective.authDir}/${fileName}`
    return syncAuthIndex(`${type}:${path}`)
  }

  /** Deterministic 16-hex index for file credentials (no recorded pin). */
  const syncAuthIndex = (seed: string): string => {
    let hash = 0x811c9dc7
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    let second = hash ^ 0x9e3779b9
    for (let i = 0; i < seed.length; i += 1) {
      second = Math.imul(second ^ seed.charCodeAt(i), 0x85ebca6b) >>> 0
    }
    return ((hash >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0'))
  }

  // ---- boot: materialize the effective config from the mounted bytes -----
  materialize(deps.configYaml)

  const fileRegistry = new AuthFileRegistry(store, deriveFileAuthIndex, effective.authDir, now, zoneOffset)

  const sidecars = new CooldownSidecars(store, now)

  // ---- on-demand credential index registry -------------------------------
  const allCredentialIndices = async (): Promise<Map<string, { provider: string; models: readonly string[] }>> => {
    const out = new Map<string, { provider: string; models: readonly string[] }>()
    for (const [, spec] of Object.entries(PROVIDER_LISTS) as Array<[string, (typeof PROVIDER_LISTS)[ProviderListKey]]>) {
      const entries = ((effective as unknown as { [key: string]: readonly ProviderEntry[] | undefined })[spec.key]) ?? []
      for (const entry of entries) {
        const models = entry.models.map((model) => model.alias)
        if (spec.family === 'openai-compatibility') {
          for (const sub of entry.apiKeyEntries ?? []) {
            const index = await credentialAuthIndex('openai-compatibility', entry.baseUrl ?? '', sub.apiKey)
            if (!out.has(index)) out.set(index, { provider: entry.name ?? '', models })
          }
          continue
        }
        const index = await credentialAuthIndex(spec.literal, entry.baseUrl ?? '', entry.apiKey)
        if (!out.has(index)) out.set(index, { provider: spec.family, models })
      }
    }
    return out
  }


  const emitLog = async (level: string, source: string, message: string): Promise<void> => {
    const stamp = stampFor(now(), zoneOffset)
    const line = formatRingLine({ line: message, level, timestamp: stamp, requestId: '--------' }, source)
    await appendLogRing(store, { line, level, timestamp: stamp, requestId: '--------' })
  }

  // ---- request body helpers ----------------------------------------------
  const readBodyText = async (request: Request): Promise<string> => request.text()

  const readJsonObject = async (request: Request): Promise<Record<string, unknown> | undefined> => {
    const parsed = parseJsonGo(await readBodyText(request))
    if (!parsed.ok) return undefined
    return asPlainRecord(parsed.value)
  }

  // ---- handle(): auth + dispatch ------------------------------------------
  async function handle(request: Request): Promise<WireResponse> {
    await booted
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method.toUpperCase()

    if (path === '/v0/resource/plugins' || path.startsWith('/v0/resource/plugins/')) {
      return respond({ status: 404, body: null })
    }
    if (path !== '/v0/management' && !path.startsWith('/v0/management/')) {
      return respond({ status: 404, body: null, bare: true })
    }
    if (method === 'OPTIONS') {
      return respond({ status: 204, body: null })
    }
    if (!authPlane.managementAvailable()) {
      return respond({ status: 404, body: null, bare: true })
    }

    const relative = path.slice('/v0/management'.length)
    const segments = relative.split('/').filter((segment) => segment !== '').map(decodeURIComponent)
    const query = url.searchParams

    // The callback route sits outside the management auth middleware.
    if (segments.length === 1 && segments[0] === 'oauth-callback' && (method === 'GET' || method === 'POST')) {
      const planeResponse = await authPlane.handleManagementOauthCallback(request)
      const body = await planeResponse.text()
      return respond({
        status: planeResponse.status,
        body,
        noBuildHeaders: true,
        contentType: JSON_CONTENT_TYPE,
      })
    }

    const verdict = await authPlane.authenticateManagement(request)
    if (!verdict.ok) {
      const body = await verdict.response.text()
      return json(verdict.response.status, body)
    }

    return dispatch(method, segments, query, request)
  }

  // ---- route dispatch ------------------------------------------------------
  async function dispatch(
    method: string,
    segments: readonly string[],
    query: URLSearchParams,
    request: Request,
  ): Promise<WireResponse> {
    const [first] = segments
    const rest = segments.slice(1)

    // ---- core config ----
    if (first === 'config' && rest.length === 0 && method === 'GET') {
      return json(200, goJson(configViewWire(effective)))
    }
    if (first === 'config.yaml' && rest.length === 0) {
      if (method === 'GET') {
        return respond({
          status: 200,
          body: configText,
          contentType: 'application/yaml; charset=utf-8',
          extra: [
            ['Cache-Control', 'no-store'],
            ['X-Content-Type-Options', 'nosniff'],
          ],
        })
      }
      if (method === 'PUT') {
        return putConfigYaml(await readBodyText(request))
      }
      return respond({ status: 404, body: null })
    }
    if (first === 'latest-version' && rest.length === 0 && method === 'GET') {
      return ginError(500, 'failed to fetch latest version')
    }

    // ---- scalar fields ----
    const relative = segments.join('/')
    const scalar = scalarRoute(relative)
    if (scalar !== undefined) {
      return scalarHandler(method, scalar, query, request)
    }

    // ---- api-keys ----
    if (first === 'api-keys' && rest.length === 0) {
      return apiKeysHandler(method, query, request)
    }

    // ---- provider lists ----
    if (rest.length === 0 && (first ?? '') in PROVIDER_LISTS) {
      return providerListHandler(method, first as ProviderListKey, query, request)
    }

    // ---- oauth maps ----
    if (rest.length === 0 && (first === 'oauth-excluded-models' || first === 'oauth-model-alias' || first === 'oauth-request-scoped-errors')) {
      return oauthMapHandler(method, first, query, request)
    }

    // ---- auth files ----
    if (first === 'auth-files') {
      return authFilesHandler(method, rest, query, request)
    }
    if (first === 'vertex' && rest[0] === 'import' && method === 'POST') {
      return vertexImportHandler(request, query)
    }

    // ---- usage / quota ----
    if (first === 'api-key-usage' && rest.length === 0 && method === 'GET') {
      return apiKeyUsageHandler()
    }
    if (first === 'usage-queue' && rest.length === 0 && method === 'GET') {
      return usageQueueHandler(query)
    }
    if (first === 'reset-quota' && rest.length === 0 && method === 'POST') {
      return resetQuotaHandler(request)
    }
    if (first === 'quota') {
      if (rest[0] === 'providers' && rest.length === 1 && method === 'GET') {
        return json(200, goJson({ providers: [] }))
      }
      if (rest[0] === 'fetch' && rest.length === 1 && method === 'POST') {
        return quotaFetchHandler(request)
      }
      if (rest[0] === 'reset' && rest.length === 1 && method === 'POST') {
        return quotaResetHandler(request)
      }
    }

    // ---- logs ----
    if (first === 'logs' && rest.length === 0) {
      if (method === 'GET') return logsReadHandler(query)
      if (method === 'DELETE') return logsClearHandler()
    }
    if (first === 'request-error-logs' && rest.length === 0 && method === 'GET') {
      return json(200, goJson({ files: [] }))
    }
    if (first === 'request-error-logs' && rest.length === 1 && method === 'GET') {
      const name = rest[0] ?? ''
      if (name.includes('/') || name.includes('\\')) return ginError(400, 'invalid log file name')
      if (!/^error-.*\.log$/.test(name)) return ginError(404, 'log file not found')
      return ginError(404, 'log file not found')
    }
    if (first === 'request-log-by-id' && rest.length === 1 && method === 'GET') {
      const id = rest[0] ?? ''
      if (id === '') return ginError(400, 'missing request ID')
      if (id.includes('/') || id.includes('\\')) return ginError(400, 'invalid request ID')
      if (!effective.loggingToFile) return ginError(404, 'log directory not found')
      return ginError(404, 'log file not found for the given request ID')
    }

    // ---- plugins ----
    if (first === 'plugins' && rest.length === 0 && method === 'GET') {
      return json(200, goJson(ordered([
        ['plugins_enabled', effective.plugins.enabled],
        ['plugins_dir', effective.plugins.dir],
        ['plugins', []],
      ])))
    }
    if (first === 'plugins' && rest.length >= 1) {
      return pluginHandler(method, rest, query, request)
    }
    if (first === 'plugin-store') {
      return ginError(500, 'handler unavailable')
    }

    // ---- oauth sessions ----
    if (first === 'get-auth-status' && rest.length === 0 && method === 'GET') {
      const planeResponse = await authPlane.handleGetAuthStatus(request)
      return json(planeResponse.status, await planeResponse.text())
    }
    if (first === 'oauth-session' && rest.length === 0 && method === 'DELETE') {
      const planeResponse = await authPlane.handleOauthSession(request)
      return json(planeResponse.status, await planeResponse.text())
    }
    const authUrl = authUrlProviderOf(first ?? '')
    if (authUrl !== undefined && rest.length === 0 && method === 'GET') {
      const planeResponse = await authPlane.handleAuthUrl(request, authUrl)
      return json(planeResponse.status, await planeResponse.text())
    }

    // ---- model definitions ----
    if (first === 'model-definitions') {
      if (rest.length === 0) return respond({ status: 404, body: null })
      if (rest.length === 1 && method === 'GET') {
        const channel = canonicalChannel(rest[0] ?? '')
        if (channel === undefined) {
          return json(400, goJson({ channel: rest[0] ?? '', error: 'unknown channel' }))
        }
        const catalog = channelCatalog(channel)
        return json(200, goJson({ channel, models: (catalog ?? []).map(catalogModelWire) }))
      }
      return respond({ status: 404, body: null })
    }

    // ---- api-call ----
    if (first === 'api-call' && rest.length === 0 && method === 'POST') {
      return apiCallHandler(request)
    }

    return respond({ status: 404, body: null })
  }

  const authUrlProviderOf = (segment: string): 'anthropic' | 'codex' | 'antigravity' | 'devin' | 'kimi' | 'xai' | 'meta' | undefined => {
    switch (segment) {
      case 'anthropic-auth-url':
        return 'anthropic'
      case 'codex-auth-url':
        return 'codex'
      case 'antigravity-auth-url':
        return 'antigravity'
      case 'devin-auth-url':
        return 'devin'
      case 'kimi-auth-url':
        return 'kimi'
      case 'xai-auth-url':
        return 'xai'
      case 'meta-auth-url':
        return 'meta'
      default:
        return undefined
    }
  }

  // ---- scalar fields -------------------------------------------------------
  interface ScalarRoute {
    readonly key: string
    readonly kind: 'bool' | 'int' | 'string'
    readonly path: readonly string[]
    readonly yamlKey: string
    readonly read: (config: EffectiveConfig) => WireValue
    readonly write: (config: EffectiveConfig, value: JsonValue) => void
    readonly getResponseKey?: string
  }

  function scalarRoute(path: string): ScalarRoute | undefined {
    switch (path) {
      case 'debug':
        return {
          key: 'debug', kind: 'bool', path: [], yamlKey: 'debug',
          read: (c) => c.debug,
          write: (c, v) => { c.debug = v === true },
        }
      case 'logging-to-file':
        return {
          key: 'logging-to-file', kind: 'bool', path: [], yamlKey: 'logging-to-file',
          read: (c) => c.loggingToFile,
          write: (c, v) => { c.loggingToFile = v === true },
        }
      case 'logs-max-total-size-mb':
        return {
          key: 'logs-max-total-size-mb', kind: 'int', path: [], yamlKey: 'logs-max-total-size-mb',
          read: (c) => c.logsMaxTotalSizeMb,
          write: (c, v) => { c.logsMaxTotalSizeMb = typeof v === 'number' && v > 0 ? Math.trunc(v) : 0 },
        }
      case 'error-logs-max-files':
        return {
          key: 'error-logs-max-files', kind: 'int', path: [], yamlKey: 'error-logs-max-files',
          read: (c) => c.errorLogsMaxFiles,
          write: (c, v) => { c.errorLogsMaxFiles = typeof v === 'number' && v >= 0 ? Math.trunc(v) : 10 },
        }
      case 'usage-statistics-enabled':
        return {
          key: 'usage-statistics-enabled', kind: 'bool', path: [], yamlKey: 'usage-statistics-enabled',
          read: (c) => c.usageStatisticsEnabled,
          write: (c, v) => { c.usageStatisticsEnabled = v === true },
        }
      case 'request-log':
        return {
          key: 'request-log', kind: 'bool', path: [], yamlKey: 'request-log',
          read: (c) => c.requestLog,
          write: (c, v) => { c.requestLog = v === true },
        }
      case 'ws-auth':
        return {
          key: 'ws-auth', kind: 'bool', path: [], yamlKey: 'ws-auth',
          read: (c) => c.wsAuth,
          write: (c, v) => { c.wsAuth = v === true },
        }
      case 'request-retry':
        return {
          key: 'request-retry', kind: 'int', path: [], yamlKey: 'request-retry',
          read: (c) => c.requestRetry,
          write: (c, v) => { c.requestRetry = typeof v === 'number' ? Math.trunc(v) : 0 },
        }
      case 'max-retry-credentials':
        return {
          key: 'max-retry-credentials', kind: 'int', path: [], yamlKey: 'max-retry-credentials',
          read: (c) => c.maxRetryCredentials,
          write: (c, v) => { c.maxRetryCredentials = typeof v === 'number' && v > 0 ? Math.trunc(v) : 0 },
        }
      case 'max-retry-interval':
        return {
          key: 'max-retry-interval', kind: 'int', path: [], yamlKey: 'max-retry-interval',
          read: (c) => c.maxRetryInterval,
          write: (c, v) => { c.maxRetryInterval = typeof v === 'number' && v > 0 ? Math.trunc(v) : 0 },
        }
      case 'force-model-prefix':
        return {
          key: 'force-model-prefix', kind: 'bool', path: [], yamlKey: 'force-model-prefix',
          read: (c) => c.forceModelPrefix,
          write: (c, v) => { c.forceModelPrefix = v === true },
        }
      case 'proxy-url':
        return {
          key: 'proxy-url', kind: 'string', path: [], yamlKey: 'proxy-url',
          read: (c) => c.proxyUrl,
          write: (c, v) => { c.proxyUrl = typeof v === 'string' ? v : '' },
        }
      case 'quota-exceeded/switch-project':
        return {
          key: 'switch-project', kind: 'bool', path: ['quota-exceeded'], yamlKey: 'switch-project',
          read: (c) => c.quotaExceeded.switchProject,
          write: (c, v) => { c.quotaExceeded.switchProject = v === true },
        }
      case 'quota-exceeded/switch-preview-model':
        return {
          key: 'switch-preview-model', kind: 'bool', path: ['quota-exceeded'], yamlKey: 'switch-preview-model',
          read: (c) => c.quotaExceeded.switchPreviewModel,
          write: (c, v) => { c.quotaExceeded.switchPreviewModel = v === true },
        }
      case 'routing/strategy':
        return {
          key: 'strategy', kind: 'string', path: ['routing'], yamlKey: 'strategy',
          read: (c) => c.routing.strategy,
          write: (c, v) => { c.routing.strategy = typeof v === 'string' ? v : 'round-robin' },
        }
      default:
        return undefined
    }
  }

  async function scalarHandler(
    method: string,
    route: ScalarRoute,
    query: URLSearchParams,
    request: Request,
  ): Promise<WireResponse> {
    if (method === 'GET') {
      return json(200, goJson({ [route.key]: route.read(effective) }))
    }
    if (method === 'PUT' || method === 'PATCH') {
      const parsed = parseJsonGo(await readBodyText(request))
      if (!parsed.ok) return ginError(400, 'invalid body')
      const record = asPlainRecord(parsed.value)
      const value = record?.['value']
      if (value === undefined || value === null) return ginError(400, 'invalid body')
      if (route.kind === 'bool' && typeof value !== 'boolean') return ginError(400, 'invalid body')
      if (route.kind === 'int' && (typeof value !== 'number' || !Number.isInteger(value))) return ginError(400, 'invalid body')
      if (route.kind === 'string' && typeof value !== 'string') return ginError(400, 'invalid body')
      if (route.key === 'strategy') {
        const normalized = normalizeStrategy(String(value))
        if (normalized === undefined) return ginError(400, 'invalid strategy')
        route.write(effective, normalized)
        persistNestedScalar(route.path, route.yamlKey, normalized)
        return json(200, goJson({ status: 'ok' }))
      }
      route.write(effective, value as JsonValue)
      if (route.path.length === 0) persistScalar(route.yamlKey, value as JsonValue)
      else persistNestedScalar(route.path, route.yamlKey, value as JsonValue)
      return json(200, goJson({ status: 'ok' }))
    }
    if (method === 'DELETE' && route.key === 'proxy-url') {
      effective.proxyUrl = ''
      persistScalar('proxy-url', '')
      return json(200, goJson({ status: 'ok' }))
    }
    return respond({ status: 404, body: null })
  }

  // ---- config.yaml PUT ------------------------------------------------------
  function putConfigYaml(body: string): WireResponse {
    let sanitized: string
    try {
      sanitized = normalizeConfigText(body, undefined)
      loadEffectiveConfig(sanitized)
    } catch (error) {
      if (error instanceof YamlError) {
        return json(400, goJson({ error: 'invalid_yaml', message: error.message }))
      }
      if (error instanceof ConfigValidationError) {
        return json(422, goJson({ error: 'invalid_config', message: error.message }))
      }
      throw error
    }
    // Persist the bytes as written (the caller's document is authoritative);
    // the bcrypt write-back rewrites only a plaintext secret key.
    let stored = body
    const secret = readSecretKey(body)
    if (secret !== undefined && secret !== '' && !looksLikeBcrypt(secret)) {
      const hashed = prepareManagementSecretSync(secret).stored
      const editor = new YamlFileEditor(body)
      editor.setScalar(['remote-management'], 'secret-key', hashed)
      editor.ensureTrailingNewline()
      stored = editor.getText()
    }
    configText = stored
    reloadEffective()
    return json(200, goJson({ changed: ['config'], ok: true }))
  }

  // ---- api-keys --------------------------------------------------------------
  async function apiKeysHandler(method: string, query: URLSearchParams, request: Request): Promise<WireResponse> {
    if (method === 'GET') {
      return json(200, goJson({ 'api-keys': [...effective.apiKeys] }))
    }
    if (method === 'PUT') {
      const parsed = parseJsonGo(await readBodyText(request))
      if (!parsed.ok) return ginError(400, 'invalid body')
      const value = parsed.value
      let items: string[] | undefined
      if (Array.isArray(value)) {
        items = value.every((item) => typeof item === 'string') ? (value as string[]) : undefined
      } else {
        const record = asPlainRecord(value)
        const raw = record?.['items']
        if (Array.isArray(raw) && raw.every((item) => typeof item === 'string') && raw.length > 0) {
          items = raw as string[]
        }
      }
      if (items === undefined || (Array.isArray(value) && value.length === 0)) {
        return ginError(400, 'invalid body')
      }
      effective.apiKeys = items ?? []
      persistSequence('api-keys', items ?? [])
      return json(200, goJson({ status: 'ok' }))
    }
    if (method === 'PATCH') {
      const record = await readJsonObject(request)
      if (record === undefined) return ginError(400, 'invalid body')
      const index = record['index']
      const value = record['value']
      const old = record['old']
      const next = record['new']
      const keys = [...effective.apiKeys]
      if (typeof index === 'number' && typeof value === 'string') {
        if (index < 0 || index >= keys.length) return ginError(400, 'missing fields')
        keys[index] = value
      } else if (typeof old === 'string' && typeof next === 'string') {
        const at = keys.indexOf(old)
        if (at === -1) keys.push(next)
        else keys[at] = next
      } else {
        return ginError(400, 'missing fields')
      }
      effective.apiKeys = keys
      persistSequence('api-keys', keys)
      return json(200, goJson({ status: 'ok' }))
    }
    if (method === 'DELETE') {
      const indexText = query.get('index')
      const value = query.get('value')
      if (indexText !== null) {
        const index = Number(indexText)
        if (!Number.isInteger(index) || index < 0 || index >= effective.apiKeys.length) {
          return ginError(400, 'missing index or value')
        }
        const keys = [...effective.apiKeys]
        keys.splice(index, 1)
        effective.apiKeys = keys
        persistSequence('api-keys', keys)
        return json(200, goJson({ status: 'ok' }))
      }
      if (value !== null) {
        effective.apiKeys = effective.apiKeys.filter((item) => item !== value)
        persistSequence('api-keys', [...effective.apiKeys])
        return json(200, goJson({ status: 'ok' }))
      }
      return ginError(400, 'missing index or value')
    }
    return respond({ status: 404, body: null })
  }

  // ---- provider lists --------------------------------------------------------
  async function providerListHandler(
    method: string,
    path: ProviderListKey,
    query: URLSearchParams,
    request: Request,
  ): Promise<WireResponse> {
    const spec = PROVIDER_LISTS[path]
    const readList = (): ProviderEntry[] =>
      [...(((effective as unknown as { [key: string]: readonly ProviderEntry[] | undefined })[spec.key]) ?? [])]

    if (method === 'GET') {
      const current = readList()
      const entries = await Promise.all(
        current.map(async (entry) => {
          if (spec.family === 'openai-compatibility') {
            const subs = await Promise.all(
              (entry.apiKeyEntries ?? []).map(async (sub: ApiKeyEntry): Promise<[string, WireValue]> => {
                const index = await apiKeyEntryAuthIndex(entry.baseUrl ?? '', sub.apiKey)
                const members: Array<[string, WireValue]> = [['api-key', sub.apiKey]]
                if (sub.weight !== undefined) members.push(['weight', sub.weight])
                if (sub.proxyUrl !== undefined) members.push(['proxy-url', sub.proxyUrl])
                members.push(['auth-index', index])
                return ['entry', ordered(members)]
              }),
            )
            const wire = providerEntryWire(entry, 'openai-compatibility', undefined, { includeDisabled: true })
            const apiKeyEntries = subs.map(([, wireValue]) => wireValue)
            const replaced = ordered(
              wire.members.map(([key, value]) => [
                key,
                key === 'api-key-entries' ? apiKeyEntries : value,
              ] as [string, WireValue]),
            )
            return replaced
          }
          const index = await listAuthIndexOf(spec, entry)
          return providerEntryWire(entry, spec.family, index === undefined ? [] : [['auth-index', index]], { includeDisabled: true })
        }),
      )
      return json(200, goJson({ [path]: entries }))
    }

    if (method === 'PUT') {
      const parsed = parseJsonGo(await readBodyText(request))
      if (!parsed.ok) return ginError(400, 'invalid body')
      let rawEntries: unknown[] | undefined
      if (Array.isArray(parsed.value)) rawEntries = parsed.value
      else {
        const record = asPlainRecord(parsed.value)
        const items = record?.['items']
        if (Array.isArray(items) && items.length > 0) rawEntries = items
      }
      if (rawEntries === undefined) return ginError(400, 'invalid body')
      const sanitized: ProviderEntry[] = []
      for (let i = 0; i < rawEntries.length; i += 1) {
        const raw = asPlainRecord(rawEntries[i])
        if (raw === undefined) return ginError(400, 'invalid body')
        const weight = raw['weight']
        if (weight !== undefined && (typeof weight !== 'number' || !Number.isInteger(weight))) {
          return ginError(400, 'weight must be an integer')
        }
        if (typeof weight === 'number' && weight > 1_000_000) {
          return ginError(400, `${path}[${i}].weight: weight must not exceed 1000000`)
        }
        if (spec.family === 'vertex' && typeof raw['api-key'] === 'string' && (raw['api-key'] as string) === '') {
          return ginError(400, `${path}[${i}].api-key is required`)
        }
        if (spec.family === 'vertex' && raw['api-key'] === undefined) {
          return ginError(400, `${path}[${i}].api-key is required`)
        }
        if (spec.family === 'claude') {
          const fingerprint = raw['fingerprint-profile']
          if (fingerprint !== undefined && typeof fingerprint !== 'string') {
            return ginError(400, `claude-api-key[${i}].fingerprint-profile: must be a string`)
          }
        }
        sanitized.push(parseAndSanitizeEntry(path, spec, raw))
      }
      const cleaned = sanitizeFamily(spec.family, sanitized)
      for (let i = 0; i < cleaned.length; i += 1) {
        const weight = cleaned[i]?.weight
        if (weight !== undefined && weight > 1_000_000) {
          return ginError(400, `${path}[${i}].weight: weight must not exceed 1000000`)
        }
      }
      storeFamily(spec, cleaned)
      persistProviderList(path, cleaned.map((entry) => entry.raw))
      return json(200, goJson({ status: 'ok' }))
    }

    if (method === 'PATCH') {
      const record = await readJsonObject(request)
      if (record === undefined) return ginError(400, 'invalid body')
      const index = record['index']
      const match = record['match']
      const name = record['name']
      const value = record['value']
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return ginError(400, 'invalid body')
      }
      const patch = asPlainRecord(value)
      if (patch === undefined) return ginError(400, 'invalid body')
      const weight = patch['weight']
      if (weight !== undefined && weight !== null && (typeof weight !== 'number' || !Number.isInteger(weight))) {
        return ginError(400, 'weight must be an integer')
      }
      if (typeof weight === 'number' && weight > 1_000_000) {
        return ginError(400, 'weight must not exceed 1000000')
      }
      let targetIndex: number | undefined
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < current.length) {
        targetIndex = index
      } else if (spec.family === 'openai-compatibility') {
        if (typeof name !== 'string') return ginError(400, 'item not found')
        targetIndex = current.findIndex((entry) => entry.name === name)
      } else {
        if (typeof match !== 'string') return ginError(400, 'item not found')
        const matches = current.filter((entry) => entry.apiKey === match)
        if (matches.length > 1) return ginError(400, 'multiple items match; index is required')
        targetIndex = current.findIndex((entry) => entry.apiKey === match)
      }
      if (targetIndex === undefined || targetIndex === -1) return ginError(404, 'item not found')
      const merged = mergeEntryPatch(spec, current[targetIndex] ?? { apiKey: '', models: [], raw: {} }, patch)
      // Removal quirks.
      const removal =
        (spec.family === 'gemini' || spec.family === 'interactions') && merged.apiKey === '' && (merged.baseUrl ?? '') === ''
        if (removal) current.splice(targetIndex, 1)
      else if ((spec.family === 'codex' || spec.family === 'xai') && (merged.baseUrl ?? '') === '') current.splice(targetIndex, 1)
      else if (spec.family === 'vertex' && merged.apiKey === '') current.splice(targetIndex, 1)
      else if (spec.family === 'openai-compatibility' && (merged.baseUrl ?? '') === '') current.splice(targetIndex, 1)
      else if (spec.family === 'meta' && merged.apiKey === '') current.splice(targetIndex, 1)
      else current[targetIndex] = merged
      const cleaned = sanitizeFamily(spec.family, current)
      storeFamily(spec, cleaned)
      persistProviderList(path, cleaned.map((entry) => entry.raw))
      return json(200, goJson({ status: 'ok' }))
    }

    if (method === 'DELETE') {
      const apiKeyParam = query.get('api-key')
      const indexParam = query.get('index')
      const nameParam = query.get('name')
      let targetIndex: number | undefined
      if (indexParam !== null) {
        const index = Number(indexParam)
        if (Number.isInteger(index) && index >= 0 && index < current.length) targetIndex = index
      }
      if (targetIndex === undefined && apiKeyParam !== null) {
        if (spec.family === 'openai-compatibility') return ginError(400, 'missing name or index')
        const matches = current.filter((entry) => entry.apiKey === apiKeyParam)
        if (matches.length === 0) return ginError(404, 'item not found')
        if (matches.length > 1) return ginError(400, 'multiple items match api-key; base-url is required')
        targetIndex = current.findIndex((entry) => entry.apiKey === apiKeyParam)
      }
      if (targetIndex === undefined && nameParam !== null && spec.family === 'openai-compatibility') {
        targetIndex = current.findIndex((entry) => entry.name === nameParam)
      }
      if (targetIndex === undefined) {
        return ginError(400, spec.family === 'openai-compatibility' ? 'missing name or index' : 'missing api-key or index')
      }
      if (targetIndex === -1) return ginError(404, 'item not found')
      current.splice(targetIndex, 1)
      const cleaned = sanitizeFamily(spec.family, current)
      storeFamily(spec, cleaned)
      persistProviderList(path, cleaned.map((entry) => entry.raw))
      return json(200, goJson({ status: 'ok' }))
    }

    return respond({ status: 404, body: null })
  }

  // ---- provider helpers -------------------------------------------------------
  type Family = (typeof PROVIDER_LISTS)[ProviderListKey]['family']

  function parseAndSanitizeEntry(path: ProviderListKey, spec: (typeof PROVIDER_LISTS)[ProviderListKey], raw: Record<string, unknown>): ProviderEntry {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, value] of Object.entries(raw)) {
      record[key] = value as JsonValue
    }
    const parsed = parseProviderRecord(record)
    if (spec.family === 'openai-compatibility') {
      return {
        ...parsed,
        name: typeof record['name'] === 'string' ? (record['name'] as string) : '',
        disabled: record['disabled'] === true,
        apiKeyEntries: parseSubEntries(record['api-key-entries']),
      }
    }
    if (spec.family === 'meta') {
      const apiKey = typeof record['api-key'] === 'string' ? (record['api-key'] as string) : ''
      const baseUrl = (parsed.baseUrl ?? '') === '' ? 'https://api.meta.ai/v1' : parsed.baseUrl
      return { ...parsed, apiKey, baseUrl: baseUrl ?? 'https://api.meta.ai/v1', raw: { ...record, 'base-url': baseUrl ?? 'https://api.meta.ai/v1' } }
    }
    return parsed
  }

  /** Parses one raw JSON record into a ProviderEntry (shared with config.ts). */
  function parseProviderRecord(record: { [key: string]: JsonValue }): ProviderEntry {
    const models = Array.isArray(record['models'])
      ? (record['models'] as JsonValue[])
          .map((item) => {
            const model = (typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}) as { [key: string]: JsonValue }
            const name = typeof model['name'] === 'string' ? (model['name'] as string) : ''
            const rawAlias = model['alias']
            const alias = typeof rawAlias === 'string' && rawAlias !== '' ? rawAlias : name
            return {
              name,
              alias,
              raw: model,
            }
          })
          .filter((model) => model.name !== '')
      : []
    const weight = record['weight']
    const priority = record['priority']
    const baseUrl = record['base-url']
    const proxyUrl = record['proxy-url']
    const prefix = record['prefix']
    return {
      apiKey: typeof record['api-key'] === 'string' ? (record['api-key'] as string) : '',
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
      ...(typeof proxyUrl === 'string' && proxyUrl !== '' ? { proxyUrl } : {}),
      ...(typeof prefix === 'string' && prefix !== '' ? { prefix } : {}),
      ...(typeof priority === 'number' ? { priority } : {}),
      ...(typeof weight === 'number' ? { weight } : {}),
      models,
      raw: record,
    }
  }

  function parseSubEntries(value: JsonValue | undefined): ApiKeyEntry[] {
    if (!Array.isArray(value)) return []
    const out: ApiKeyEntry[] = []
    for (const item of value) {
      const record = (typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}) as { [key: string]: JsonValue }
      const apiKey = typeof record['api-key'] === 'string' ? (record['api-key'] as string) : ''
      if (apiKey === '') continue
      const weight = record['weight']
      const proxyUrl = record['proxy-url']
      out.push({
        apiKey,
        ...(typeof weight === 'number' ? { weight } : {}),
        ...(typeof proxyUrl === 'string' && proxyUrl !== '' ? { proxyUrl } : {}),
        raw: record,
      })
    }
    return out
  }

  function sanitizeFamily(family: Family, entries: readonly ProviderEntry[]): ProviderEntry[] {
    switch (family) {
      case 'gemini':
      case 'interactions': {
        return entries.filter((entry) => !(entry.apiKey === '' && (entry.baseUrl ?? '') === ''))
      }
      case 'codex':
      case 'xai':
      case 'openai-compatibility': {
        return entries.filter((entry) => (entry.baseUrl ?? '') !== '')
      }
      case 'meta': {
        return entries
          .filter((entry) => entry.apiKey !== '' && !entry.apiKey.startsWith('dca:'))
          .map((entry) => ({ ...entry, baseUrl: (entry.baseUrl ?? '') === '' ? 'https://api.meta.ai/v1' : entry.baseUrl }))
      }
      default:
        return [...entries]
    }
  }

  function storeFamily(spec: (typeof PROVIDER_LISTS)[ProviderListKey], entries: readonly ProviderEntry[]): void {
    const record = effective as unknown as { [key: string]: unknown }
    record[spec.key] = [...entries]
  }

  function mergeEntryPatch(spec: (typeof PROVIDER_LISTS)[ProviderListKey], current: ProviderEntry, patch: Record<string, unknown>): ProviderEntry {
    const raw: { [key: string]: JsonValue } = { ...current.raw }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete raw[key]
      else raw[key] = value as JsonValue
    }
    const merged = parseProviderRecord(raw)
    if (spec.family === 'openai-compatibility') {
      return {
        ...merged,
        name: typeof raw['name'] === 'string' ? (raw['name'] as string) : current.name ?? '',
        disabled: raw['disabled'] === true,
        apiKeyEntries: parseSubEntries(raw['api-key-entries']),
      }
    }
    if (spec.family === 'meta') {
      return { ...merged, baseUrl: (merged.baseUrl ?? '') === '' ? 'https://api.meta.ai/v1' : merged.baseUrl }
    }
    return merged
  }

  // ---- oauth maps --------------------------------------------------------------
  async function oauthMapHandler(method: string, path: string, query: URLSearchParams, request: Request): Promise<WireResponse> {
    const key = path
    const readMap = (): { [key: string]: JsonValue } => {
      const value = (effective as unknown as { [key: string]: JsonValue })[
        path === 'oauth-excluded-models' ? 'oauthExcludedModels' : path === 'oauth-model-alias' ? 'oauthModelAlias' : 'oauthRequestScopedErrors'
      ]
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as { [key: string]: JsonValue }) } : {}
    }
    const writeMap = (map: { [key: string]: JsonValue }): void => {
      const record = effective as unknown as { [key: string]: JsonValue }
      if (path === 'oauth-excluded-models') record['oauthExcludedModels'] = map
      else if (path === 'oauth-model-alias') record['oauthModelAlias'] = map
      else record['oauthRequestScopedErrors'] = map
      const editor = new YamlFileEditor(configText)
      const lines: string[] = []
      for (const [mapKey, mapValue] of Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))) {
        lines.push(...renderMappingLines({ [mapKey]: mapValue }, 0))
      }
      editor.setBlock([], key, lines)
      editor.ensureTrailingNewline()
      configText = editor.getText()
      reloadEffective()
    }

    if (method === 'GET') {
      return json(200, goJson({ [key]: readMap() }))
    }
    if (method === 'PUT') {
      const parsed = parseJsonGo(await readBodyText(request))
      if (!parsed.ok) return ginError(400, 'invalid body')
      let map: { [key: string]: JsonValue } | undefined
      if (typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
        map = parsed.value as { [key: string]: JsonValue }
      } else {
        const record = asPlainRecord(parsed.value)
        const items = record?.['items']
        if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
          map = items as { [key: string]: JsonValue }
        }
      }
      if (map === undefined) return ginError(400, 'invalid body')
      writeMap(map)
      return json(200, goJson({ status: 'ok' }))
    }
    if (method === 'PATCH') {
      const record = await readJsonObject(request)
      if (record === undefined) return ginError(400, 'invalid body')
      const channel = typeof record['channel'] === 'string' ? (record['channel'] as string) : typeof record['provider'] === 'string' ? (record['provider'] as string) : undefined
      if (channel === undefined || channel.trim() === '') return ginError(400, 'invalid channel')
      const normalized = channel.trim().toLowerCase()
      const map = readMap()
      if (path === 'oauth-excluded-models') {
        const models = record['models']
        if (!Array.isArray(models)) return ginError(400, 'invalid body')
        const list = (models as JsonValue[]).filter((item): item is string => typeof item === 'string')
        if (list.length === 0) delete map[normalized]
        else map[normalized] = list
      } else {
        const aliases = record['aliases'] ?? record['models'] ?? record['rules']
        if (!Array.isArray(aliases)) return ginError(400, 'invalid body')
        if ((aliases as unknown[]).length === 0) delete map[normalized]
        else map[normalized] = aliases as JsonValue
      }
      writeMap(map)
      return json(200, goJson({ status: 'ok' }))
    }
    if (method === 'DELETE') {
      const channel = query.get('channel') ?? query.get('provider')
      if (channel === null) return ginError(400, 'missing channel')
      const map = readMap()
      if (!(channel in map)) return ginError(404, 'channel not found')
      delete map[channel]
      writeMap(map)
      return json(200, goJson({ status: 'ok' }))
    }
    return respond({ status: 404, body: null })
  }

  // ---- auth files ----------------------------------------------------------------
  async function authFilesHandler(method: string, rest: readonly string[], query: URLSearchParams, request: Request): Promise<WireResponse> {
    const [action] = rest

    if (rest.length === 0) {
      if (method === 'GET') return authFilesListHandler(query)
      if (method === 'POST') return authFilesUploadHandler(query, request)
      if (method === 'DELETE') return authFilesDeleteHandler(query, request)
      return respond({ status: 404, body: null })
    }
    if (action === 'download' && rest.length === 1 && method === 'GET') {
      const name = query.get('name') ?? ''
      const invalid = checkAuthFileName(name)
      if (invalid !== undefined) return ginError(400, invalid)
      const found = await fileRegistry.read(name)
      if (found === undefined) return ginError(404, 'file not found')
      const bytes = fileRegistry.serialize(found.document)
      return respond({
        status: 200,
        body: bytes,
        contentType: 'application/json',
        extra: [['Content-Disposition', `attachment; filename="${name}"`]],
      })
    }
    if (action === 'models' && rest.length === 1 && method === 'GET') {
      const name = query.get('name')
      if (name === null || name === '') return ginError(400, 'name is required')
      const found = await fileRegistry.read(name)
      if (found === undefined) return ginError(404, 'auth file not found')
      const record = (typeof found.document === 'object' && found.document !== null && !Array.isArray(found.document) ? found.document : {}) as { [key: string]: JsonValue }
      const type = typeof record['type'] === 'string' ? (record['type'] as string).toLowerCase() : ''
      return json(200, goJson({ models: authFileModels(type) }))
    }
    if (action === 'status' && rest.length === 1 && method === 'PATCH') {
      const record = await readJsonObject(request)
      if (record === undefined) return ginError(400, 'invalid request body')
      const name = record['name'] ?? record['auth_index']
      if (typeof name !== 'string' || name === '') return ginError(400, 'name is required')
      const disabled = record['disabled']
      if (typeof disabled !== 'boolean') return ginError(400, 'disabled is required')
      const found = await fileRegistry.read(name)
      if (found === undefined) return ginError(404, 'auth file not found')
      const doc = (typeof found.document === 'object' && found.document !== null && !Array.isArray(found.document) ? { ...(found.document as { [key: string]: JsonValue }) } : {})
      doc['disabled'] = disabled
      await fileRegistry.write(name, doc)
      return json(200, goJson({ disabled, status: 'ok' }))
    }
    if (action === 'fields' && rest.length === 1 && method === 'PATCH') {
      const raw = await readBodyText(request)
      const parsed = parseJsonGo(raw)
      if (!parsed.ok) return ginError(400, 'invalid request body')
      const record = asPlainRecord(parsed.value)
      if (record === undefined) return ginError(400, 'invalid request body')
      const name = record['name']
      if (typeof name !== 'string' || name === '') return ginError(400, 'name is required')
      const fields = Object.entries(record).filter(([key]) => key !== 'name')
      if (fields.length === 0) return ginError(400, 'no fields to update')
      const found = await fileRegistry.read(name)
      if (found === undefined) return ginError(404, 'auth file not found')
      const doc = (typeof found.document === 'object' && found.document !== null && !Array.isArray(found.document) ? { ...(found.document as { [key: string]: JsonValue }) } : {})
      let merged: { [key: string]: JsonValue }
      try {
        merged = applyFieldPatch(doc, fields.map(([key, value]) => [key, value as JsonValue] as const))
      } catch (error) {
        if (error instanceof FieldPatchError) return ginError(400, error.message)
        throw error
      }
      await fileRegistry.write(name, merged)
      return json(200, goJson({ status: 'ok' }))
    }
    if (action === 'refresh' && rest.length === 1 && method === 'POST') {
      const record = await readJsonObject(request)
      const all = query.get('all') ?? (record !== undefined && typeof record['all'] === 'string' ? (record['all'] as string) : record !== undefined && record['all'] === true ? 'true' : null)
      const name = query.get('name') ?? (record !== undefined && typeof record['name'] === 'string' ? (record['name'] as string) : null)
      if (all !== 'true' && all !== '1' && all !== '*' && (name === null || name === '')) {
        return ginError(400, 'name or all=true is required')
      }
      if (all === 'true' || all === '1' || all === '*') {
        return json(200, goJson({ ok: true, results: [] }))
      }
      const found = name === null ? undefined : await fileRegistry.read(name)
      if (found === undefined) return ginError(404, 'auth file not found')
      return json(200, goJson({ ok: true, auth: await fileRegistry.entry(name ?? '', found.document, Math.floor(now() / 1000)) }))
    }
    return respond({ status: 404, body: null })
  }

  async function authFilesListHandler(query: URLSearchParams): Promise<WireResponse> {
    const filterName = query.get('name')
    const filterIndex = query.get('auth_index')
    const names = await fileRegistry.names()
    const nowSeconds = Math.floor(now() / 1000)
    const entries: WireValue[] = []
    for (const name of names) {
      const found = await fileRegistry.read(name)
      if (found === undefined) continue
      if (typeof found.document !== 'object' || found.document === null || Array.isArray(found.document)) continue
      if (filterName !== null && filterName !== name) continue
      if (filterIndex !== null && fileRegistry.authIndexOf(name, found.document) !== filterIndex) continue
      entries.push(await fileRegistry.entry(name, found.document, nowSeconds))
    }
    return json(200, goJson({ files: entries, observed_at: rfc3339Utc(now()) }))
  }

  async function authFilesUploadHandler(query: URLSearchParams, request: Request): Promise<WireResponse> {
    const contentType = request.headers.get('content-type') ?? ''
    const urlName = query.get('name')

    if (contentType.startsWith('multipart/form-data')) {
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType)
      if (boundaryMatch === null) return ginError(400, 'no files uploaded')
      const boundary = boundaryMatch[1] ?? boundaryMatch[2] ?? ''
      const body = await readBodyText(request)
      const parts = parseMultipart(body, boundary)
      const files = parts.filter((part) => part.filename !== undefined)
      const fields = new Map(parts.filter((part) => part.filename === undefined).map((part) => [part.name, part.value]))
      if (files.length === 0) return ginError(400, 'no files uploaded')
      const uploaded: string[] = []
      const failed: Array<{ name: string; error: string }> = []
      for (const part of files) {
        const name = part.filename ?? ''
        if (!name.endsWith('.json')) {
          failed.push({ name, error: 'file must be .json' })
          continue
        }
        const parsed = parseJsonGo(part.value)
        if (!parsed.ok) {
          failed.push({ name, error: parsed.message })
          continue
        }
        if (typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
          const doc = { ...(parsed.value as { [key: string]: JsonValue }) }
          if (doc['disabled'] === undefined) doc['disabled'] = false
          await fileRegistry.write(name, doc)
        } else {
          await fileRegistry.writeRaw(name, part.value)
        }
        uploaded.push(name)
      }
      void fields
      if (files.length === 1) {
        if (uploaded.length === 1) return json(200, goJson({ status: 'ok' }))
        return ginError(400, failed[0]?.error ?? 'invalid body')
      }
      if (uploaded.length === files.length) {
        return json(200, goJson({ status: 'ok', uploaded: uploaded.length, files: uploaded }))
      }
      return json(207, goJson({ status: 'partial', uploaded: uploaded.length, files: uploaded, failed }))
    }

    if (urlName === null) return ginError(400, 'name is required')
    const invalid = checkAuthFileName(urlName)
    if (invalid !== undefined) return ginError(400, invalid)
    const body = await readBodyText(request)
    const parsed = parseJsonGo(body)
    if (!parsed.ok) return ginError(400, 'invalid body')
    if (typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
      const doc = { ...(parsed.value as { [key: string]: JsonValue }) }
      if (doc['disabled'] === undefined) doc['disabled'] = false
      await fileRegistry.write(urlName, doc)
      return json(200, goJson({ status: 'ok' }))
    }
    await fileRegistry.writeRaw(urlName, body)
    return json(200, goJson({ status: 'ok' }))
  }

  async function authFilesDeleteHandler(query: URLSearchParams, request: Request): Promise<WireResponse> {
    const names: string[] = []
    const all = query.get('all')
    for (const name of query.getAll('name')) names.push(name)
    if (names.length === 0) {
      const raw = await readBodyText(request)
      if (raw.trim() !== '') {
        const parsed = parseJsonGo(raw)
        if (parsed.ok) {
          const record = asPlainRecord(parsed.value)
          if (Array.isArray(parsed.value)) {
            for (const item of parsed.value as unknown[]) {
              if (typeof item === 'string') names.push(item)
            }
          } else if (record !== undefined) {
            const single = record['name']
            const multiple = record['names']
            if (typeof single === 'string') names.push(single)
            if (Array.isArray(multiple)) {
              for (const item of multiple) if (typeof item === 'string') names.push(item)
            }
          }
        }
      }
    }
    if (all === 'true' || all === '1' || all === '*') {
      const existing = await fileRegistry.names()
      let deleted = 0
      for (const name of existing) {
        if (await fileRegistry.delete(name)) deleted += 1
      }
      return json(200, goJson({ status: 'ok', deleted }))
    }
    if (names.length === 0) return ginError(400, 'invalid name')
    const deleted: string[] = []
    for (const name of names) {
      const invalid = checkAuthFileName(name)
      if (invalid !== undefined) return ginError(400, invalid)
      const removed = await fileRegistry.delete(name)
      if (!removed) {
        if (deleted.length === 0) return ginError(404, 'auth file not found')
      } else {
        deleted.push(name)
      }
    }
    if (names.length === 1) return json(200, goJson({ status: 'ok' }))
    return json(200, goJson({ status: 'ok', deleted: deleted.length, files: deleted }))
  }

  interface MultipartPart {
    readonly name: string
    readonly filename?: string
    readonly value: string
  }

  function parseMultipart(body: string, boundary: string): MultipartPart[] {
    const parts: MultipartPart[] = []
    const delimiter = `--${boundary}`
    const sections = body.split(delimiter).slice(1, -1)
    for (const section of sections) {
      const normalized = section.startsWith('\r\n') ? section.slice(2) : section
      const separator = normalized.indexOf('\r\n\r\n')
      const rawHead = separator === -1 ? '' : normalized.slice(0, separator)
      const value = separator === -1 ? normalized : normalized.slice(separator + 4)
      let name = ''
      let filename: string | undefined
      for (const line of rawHead.split('\r\n')) {
        if (line.toLowerCase().startsWith('content-disposition:')) {
          const nameMatch = /name="([^"]*)"/.exec(line)
          const fileMatch = /filename="([^"]*)"/.exec(line)
          if (nameMatch !== null) name = nameMatch[1] ?? ''
          if (fileMatch !== null) filename = fileMatch[1] ?? ''
        }
      }
      const trimmed = value.endsWith('\r\n') ? value.slice(0, -2) : value
      parts.push({ name, ...(filename !== undefined ? { filename } : {}), value: trimmed })
    }
    return parts
  }

  // ---- vertex import -----------------------------------------------------------------
  async function vertexImportHandler(request: Request, query: URLSearchParams): Promise<WireResponse> {
    const contentType = request.headers.get('content-type') ?? ''
    const location = query.get('location') ?? 'us-central1'
    if (!contentType.startsWith('multipart/form-data')) {
      return ginError(400, 'file required')
    }
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType)
    if (boundaryMatch === null) return ginError(400, 'file required')
    const boundary = boundaryMatch[1] ?? boundaryMatch[2] ?? ''
    const body = await readBodyText(request)
    const parts = parseMultipart(body, boundary)
    const filePart = parts.find((part) => part.name === 'file' && part.filename !== undefined)
    const locationPart = parts.find((part) => part.name === 'location')
    const effectiveLocation = locationPart?.value ?? location
    if (filePart === undefined) return ginError(400, 'file required')

    const parsed = parseJsonGo(filePart.value)
    if (!parsed.ok) {
      return json(400, goJson({ error: 'invalid json', message: parsed.message }))
    }
    if (parsed.value === null) {
      return json(400, goJson({ error: 'invalid service account', message: 'service account payload is empty' }))
    }
    const record = asPlainRecord(parsed.value)
    if (record === undefined) {
      return json(400, goJson({ error: 'invalid service account', message: 'service account payload is empty' }))
    }
    const privateKey = record['private_key']
    if (privateKey === undefined || typeof privateKey !== 'string' || privateKey === '') {
      return json(400, goJson({ error: 'invalid service account', message: 'service account missing private_key' }))
    }
    let reEncoded: string
    try {
      reEncoded = reEncodePrivateKey(privateKey)
    } catch (error) {
      if (error instanceof ServiceAccountError) {
        return json(400, goJson({ error: 'invalid service account', message: error.message }))
      }
      throw error
    }
    const projectId = record['project_id']
    if (typeof projectId !== 'string' || projectId === '') {
      return ginError(400, 'project_id missing')
    }
    const clientEmail = typeof record['client_email'] === 'string' ? (record['client_email'] as string) : ''
    const name = vertexFileName(projectId)

    const serviceAccount: { [key: string]: JsonValue } = {
      ...(record as { [key: string]: JsonValue }),
      private_key: reEncoded,
    }
    const document: { [key: string]: JsonValue } = {
      account_type: 'oauth',
      client_email: clientEmail,
      email: clientEmail,
      location: effectiveLocation,
      project_id: projectId,
      service_account: serviceAccount,
      type: 'vertex',
    }
    await fileRegistry.write(name, document)
    const path = `${effective.authDir}/${name}`
    return json(200, goJson({
      'auth-file': path,
      email: clientEmail,
      location: effectiveLocation,
      project_id: projectId,
      status: 'ok',
    }))
  }

  // ---- usage / quota -------------------------------------------------------------------
  function apiKeyUsageHandler(): WireResponse {
    const nowSeconds = Math.floor(now() / 1000)
    const buckets = recentRequestBuckets(nowSeconds)
    const out: { [provider: string]: { [composite: string]: WireValue } } = {}
    const add = (provider: string, baseUrl: string, apiKey: string): void => {
      if (apiKey === '') return
      const entry = ordered([
        ['success', 0],
        ['failed', 0],
        ['recent_requests', buckets],
      ])
      const composite = `${baseUrl}|${apiKey}`
      const bucket = out[provider] ?? {}
      bucket[composite] = entry
      out[provider] = bucket
    }
    for (const entry of effective.claude) add('claude', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.codex) add('codex', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.gemini) add('gemini', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.interactions) add('gemini-interactions', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.meta) add('meta', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.xai) add('xai', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.vertex) add('vertex', entry.baseUrl ?? '', entry.apiKey)
    for (const entry of effective.openaiCompatibility) {
      for (const sub of entry.apiKeyEntries ?? []) {
        add(entry.name ?? '', entry.baseUrl ?? '', sub.apiKey)
      }
    }
    return json(200, goJson(out))
  }

  async function usageQueueHandler(query: URLSearchParams): Promise<WireResponse> {
    const raw = query.get('count')
    if (raw === null) {
      const records = await popUsageRecords(store, 1)
      return json(200, usageQueueArrayBody(records))
    }
    const count = Number(raw)
    if (!Number.isInteger(count) || count <= 0) {
      return ginError(400, 'count must be a positive integer')
    }
    const records = await popUsageRecords(store, count)
    return json(200, usageQueueArrayBody(records))
  }

  function usageQueueArrayBody(records: readonly string[]): string {
    if (records.length === 0) return '[]'
    const parts = records.map((record) => {
      const parsed = parseJsonGo(record)
      return parsed.ok ? record : goJson(record)
    })
    return `[${parts.join(',')}]`
  }

  async function resolveAuthIndex(record: Record<string, unknown> | undefined): Promise<{ index?: string; invalid?: boolean }> {
    const index = record?.['auth_index']
    if (typeof index !== 'string' || index === '') return { invalid: true }
    const registry = await allCredentialIndices()
    for (const file of await fileRegistry.names()) {
      const found = await fileRegistry.read(file)
      if (found !== undefined && fileRegistry.authIndexOf(file, found.document) === index) {
        return { index }
      }
    }
    if (!registry.has(index)) return {}
    return { index }
  }

  async function quotaFetchHandler(request: Request): Promise<WireResponse> {
    const record = await readJsonObject(request)
    if (record === undefined) return ginError(400, 'invalid request body')
    const resolved = await resolveAuthIndex(record)
    if (resolved.invalid === true) return ginError(400, 'auth_index is required')
    if (resolved.index === undefined) return ginError(404, 'auth not found')
    return ginError(501, 'no quota provider available for credential')
  }

  async function quotaResetHandler(request: Request): Promise<WireResponse> {
    const record = await readJsonObject(request)
    if (record === undefined) return ginError(400, 'invalid request body')
    const resolved = await resolveAuthIndex(record)
    if (resolved.invalid === true) return ginError(400, 'auth_index is required')
    if (resolved.index === undefined) return ginError(404, 'auth not found')
    return ginError(501, 'plugin host unavailable')
  }

  async function resetQuotaHandler(request: Request): Promise<WireResponse> {
    const record = await readJsonObject(request)
    if (record === undefined) return ginError(400, 'invalid request body')
    const resolved = await resolveAuthIndex(record)
    if (resolved.invalid === true) return ginError(400, 'auth_index is required')
    if (resolved.index === undefined) return ginError(404, 'auth not found')
    const registry = await allCredentialIndices()
    const credential = registry.get(resolved.index)
    return json(200, goJson({ status: 'ok', auth_index: resolved.index, models: credential?.models ?? [] }))
  }

  // ---- plugins -------------------------------------------------------------------------
  async function pluginHandler(method: string, rest: readonly string[], query: URLSearchParams, request: Request): Promise<WireResponse> {
    const id = rest[0] ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      return json(400, goJson({ error: 'invalid_plugin_id', message: 'invalid plugin id' }))
    }
    const sub = rest[1]
    if (sub === undefined) {
      if (method === 'DELETE') return json(404, goJson({ error: 'plugin_not_found', message: 'plugin not found' }))
      if (method === 'GET') return json(404, goJson({ error: 'plugin_not_found', message: 'plugin not found' }))
      return respond({ status: 404, body: null })
    }
    if (sub === 'config') {
      if (method === 'GET') return json(404, goJson({ error: 'plugin_not_found', message: 'plugin not found' }))
      if (method === 'PUT' || method === 'PATCH') {
        const parsed = parseJsonGo(await readBodyText(request))
        if (!parsed.ok) return json(400, goJson({ error: 'invalid_body', message: parsed.message }))
        if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
          return json(400, goJson({ error: 'invalid_body', message: 'body must be a JSON object' }))
        }
        return json(404, goJson({ error: 'plugin_not_found', message: 'plugin not found' }))
      }
    }
    if (sub === 'enabled' && method === 'PATCH') {
      const record = await readJsonObject(request)
      if (record === undefined || typeof record['enabled'] !== 'boolean') {
        return json(400, goJson({ error: 'invalid_body', message: 'enabled is required' }))
      }
      return json(404, goJson({ error: 'plugin_not_found', message: 'plugin not found' }))
    }
    if (sub === 'quota') {
      const authIndex = query.get('auth_index')
      if (rest[2] === 'reset' && method === 'POST') {
        const record = await readJsonObject(request)
        const index = authIndex ?? (record !== undefined && typeof record['auth_index'] === 'string' ? (record['auth_index'] as string) : null)
        if (index === null || index === '') return ginError(400, 'auth_index is required')
        const resolved = await resolveAuthIndex({ auth_index: index })
        if (resolved.index === undefined) return ginError(404, 'auth not found')
        return ginError(404, 'quota provider not found for plugin')
      }
      if (authIndex === null || authIndex === '') return ginError(400, 'auth_index is required')
      const resolved = await resolveAuthIndex({ auth_index: authIndex })
      if (resolved.index === undefined) return ginError(404, 'auth not found')
      return ginError(404, 'quota provider not found for plugin')
    }
    return respond({ status: 404, body: null })
  }

  // ---- api-call ------------------------------------------------------------------------
  async function apiCallHandler(request: Request): Promise<WireResponse> {
    const parsed = parseJsonGo(await readBodyText(request))
    if (!parsed.ok) return ginError(400, 'invalid body')
    const record = asPlainRecord(parsed.value)
    if (record === undefined) return ginError(400, 'invalid body')
    const method = typeof record['method'] === 'string' ? (record['method'] as string) : ''
    if (method === '') return ginError(400, 'missing method')
    const url = typeof record['url'] === 'string' ? (record['url'] as string) : ''
    if (url === '') return ginError(400, 'missing url')
    try {
      new URL(url)
    } catch {
      return ginError(400, 'invalid url')
    }
    const proxyUrl = record['proxy_url']
    if (proxyUrl !== undefined && typeof proxyUrl !== 'string') return ginError(400, 'invalid proxy_url')
    if (typeof proxyUrl === 'string' && proxyUrl !== '') {
      try {
        new URL(proxyUrl)
      } catch {
        return ginError(400, 'invalid proxy_url')
      }
    }
    const data = typeof record['data'] === 'string' ? (record['data'] as string) : ''
    const headerRecord = asPlainRecord(record['header'] ?? record['headers'])
    const headers: Array<[string, string]> = [['User-Agent', 'Go-http-client/1.1']]
    if (data !== '') headers.push(['Content-Length', String(byteLengthOf(data))])
    for (const [name, value] of Object.entries(headerRecord ?? {})) {
      if (typeof value === 'string') headers.push([name, value])
    }
    headers.push(['Accept-Encoding', 'gzip'])

    const sender = deps.sendUpstream
    if (sender === undefined) return ginError(502, 'request failed')
    let reply: ApiCallReply
    try {
      reply = await sender({ method, url, headers: headers as HeaderList, body: data })
    } catch {
      return ginError(502, 'request failed')
    }
    const replyMap: { [key: string]: WireValue } = {}
    for (const [rawName, value] of reply.headers) {
      const name = canonicalHeaderKey(rawName)
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      const existing = replyMap[name]
      if (existing === undefined) replyMap[name] = [value]
      else if (Array.isArray(existing)) existing.push(value)
    }
    return json(200, goJson(ordered([
      ['status_code', reply.status],
      ['header', replyMap],
      ['body', reply.body],
    ])))
  }

  // ---- log window with in-memory clear marker -----------------------------------------
  let totalLogAppends = 0
  let logClearedAt = 0

  const trackedAppendLog = async (entry: LogLineEntry): Promise<void> => {
    totalLogAppends += 1
    await appendLogRing(store, entry)
  }

  const visibleLogLines = async (): Promise<string[]> => {
    const entries = await readLogRing(store)
    const appendedAfterClear = totalLogAppends - logClearedAt
    const takeLast = Math.max(0, Math.min(appendedAfterClear, entries.length))
    return entries.slice(entries.length - takeLast).map((entry) => entry.line)
  }

  async function logsReadHandler(query: URLSearchParams): Promise<WireResponse> {
    if (!effective.loggingToFile) return ginError(400, 'logging to file disabled')
    const limitRaw = query.get('limit')
    let limit: number | undefined
    if (limitRaw !== null) {
      const parsed = Number(limitRaw)
      if (!Number.isInteger(parsed)) {
        return ginError(400, 'invalid limit: must be a positive integer')
      }
      if (parsed <= 0) return ginError(400, 'invalid limit: must be greater than zero')
      limit = parsed
    }
    const lines = await visibleLogLines()
    const windowBytes = lines.reduce((sum, line) => sum + byteLengthOf(line) + 1, 0)
    let tail = limit === undefined ? lines : lines.slice(-limit)
    const cursorRaw = query.get('cursor')
    let cursorReset = false
    if (cursorRaw !== null && cursorRaw !== '') {
      const cursor = decodeCursor(cursorRaw)
      if (cursor === undefined || cursor.offset > windowBytes) cursorReset = true
    }
    const afterRaw = query.get('after')
    if (afterRaw !== null) {
      const after = Number(afterRaw)
      if (Number.isInteger(after)) tail = tail.filter((line) => lineTimestampSeconds(line) >= after)
    }
    const latest = tail.length === 0 ? 0 : Math.max(...tail.map((line) => lineTimestampSeconds(line)))
    const cursor = await buildCursor(windowBytes, latest, now())
    return json(200, goJson({
      'latest-timestamp': latest,
      'line-count': tail.length,
      lines: [...tail],
      'next-cursor': cursor,
      ...(cursorReset ? { 'cursor-reset': true } : {}),
    }))
  }

  async function logsClearHandler(): Promise<WireResponse> {
    if (!effective.loggingToFile) return ginError(400, 'logging to file disabled')
    const lines = await visibleLogLines()
    logClearedAt = totalLogAppends
    void lines
    return json(200, goJson({ success: true, message: 'Logs cleared successfully', removed: 0 }))
  }

  const byteLengthOf = (text: string): number => new TextEncoder().encode(text).length

  // ---- state-layer operations (S6 contract) ----------------------------------------------
  async function recordUsage(completion: UsageCompletion): Promise<void> {
    const record = serializeUsageRecord(completion, now())
    const payload = goJson(record)
    const live = [...subscribers].filter((subscriber) => subscriber.channel === 'usage')
    if (live.length > 0) {
      for (const subscriber of live) subscriber.deliver(payload)
      return
    }
    await store.enqueue(USAGE_QUEUE, payload)
  }

  async function publishError(event: ErrorEventInput): Promise<void> {
    const serialized = serializeErrorEvent(event, now())
    const payload = goJson(serialized)
    await store.ringAppend('errors', JSON.parse(payload) as JsonValue, 1000)
    const live = [...subscribers].filter((subscriber) => subscriber.channel === 'errors')
    for (const subscriber of live) subscriber.deliver(payload)
  }

  function openUsageWire(): UsageWireConnection {
    const connection = openUsageWireConnection({
      verifyKey: async (
        presented: string,
      ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
        const request = new Request('http://management.internal/v0/management', {
          method: 'GET',
          headers: { authorization: `Bearer ${presented}` },
        })
        const verdict = await authPlane.authenticateManagement(request)
        if (verdict.ok) return { ok: true }
        const body = await verdict.response.text()
        const parsed = parseJsonGo(body)
        const record = parsed.ok ? asPlainRecord(parsed.value) : undefined
        const message =
          typeof record?.['error'] === 'string' ? (record['error'] as string) : 'invalid management key'
        return { ok: false, message }
      },
      popRecords: async (count: number) => {
        const records = await popUsageRecords(store, count)
        return records
      },
      popRecord: async () => {
        const records = await popUsageRecords(store, 1)
        return records[0]
      },
      subscribe: (channel, deliver) => {
        subscribers.add({ channel, deliver })
      },
      unsubscribe: (channel) => {
        for (const subscriber of [...subscribers]) {
          if (subscriber.channel === channel) subscribers.delete(subscriber)
        }
      },
    })
    return connection
  }


  async function recordCooldown(record: CooldownRecord): Promise<void> {
    await sidecars.record(record)
  }

  async function listCooldownSidecars(): Promise<ReadonlyArray<CooldownSidecar>> {
    return sidecars.list()
  }

  async function isCooling(authId: string, model?: string): Promise<boolean> {
    return sidecars.isCooling(authId, model)
  }

  async function appendLogLine(entry: LogLineEntry): Promise<void> {
    await trackedAppendLog(entry)
  }

  async function readLogRingEntries(): Promise<readonly LogLineEntry[]> {
    return readLogRing(store)
  }

  async function buildModelList(): Promise<string> {
    const created = Math.floor(now() / 1000)
    const entries: Array<[string, string]> = []
    const push = (ownedBy: string, aliases: readonly string[]): void => {
      for (const alias of aliases) entries.push([alias, ownedBy])
    }
    for (const entry of effective.gemini) push('google', entry.models.map((model) => model.alias))
    for (const entry of effective.interactions) push('google', entry.models.map((model) => model.alias))
    for (const entry of effective.vertex) push('google', entry.models.map((model) => model.alias))
    for (const entry of effective.claude) push('anthropic', entry.models.map((model) => model.alias))
    for (const entry of effective.codex) push('openai', entry.models.map((model) => model.alias))
    for (const entry of effective.xai) push('xai', entry.models.map((model) => model.alias))
    for (const entry of effective.meta) push('meta', entry.models.map((model) => model.alias))
    for (const entry of effective.openaiCompatibility) push(entry.name ?? '', entry.models.map((model) => model.alias))
    const data = entries.map(([id, ownedBy]) => ({
      created,
      id,
      object: 'model',
      owned_by: ownedBy,
    }))
    return goJson(ordered([['data', data], ['object', 'list']]))
  }

  async function readConfigFile(): Promise<string> {
    return configText
  }

  async function replaceConfigFile(yaml: string): Promise<void> {
    materialize(yaml)
    await emitLog('info', 'config-reload.ts:1', 'config successfully reloaded, triggering client reload')
  }

  /** Boot seeding promise: the ring seed finishes before the first request. */
  const booted = (async (): Promise<void> => {
    for (const entry of deps.initialLogLines ?? []) {
      await trackedAppendLog(entry)
    }
  })()

  return {
    handle,
    recordUsage,
    publishError,
    openUsageWire,
    recordCooldown,
    listCooldownSidecars,
    isCooling,
    appendLogLine,
    readLogRing: readLogRingEntries,
    buildModelList,
    readConfigFile,
    replaceConfigFile,
  }
}

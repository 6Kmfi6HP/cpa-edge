/**
 * S3 auth-plane golden contract suite — spec/sections/S3-auth-flows.md
 * =================================================================
 *
 * Red-until-implemented notice
 * ----------------------------
 * `packages/auth` currently ships an empty index. This suite therefore FAILS
 * on every case with an explicit "auth plane not available" message until
 * Phase 2 (I-auth) exports the surface specified below. That red state is
 * the agreed Phase-1 outcome; the runner collects and reports normally, it
 * never crashes on the missing module (the import is dynamic and narrowed
 * before any call). Nothing here is left unfinished on purpose.
 *
 * What this file specifies (the contract for @cpa-edge/auth)
 * ---------------------------------------------------------
 * The suite is simultaneously the executable contract for the future auth
 * implementation. It expects exactly one factory export:
 *
 *   createAuthPlane(config: AuthPlaneConfig, deps?: AuthPlaneDeps): AuthPlane
 *
 * `AuthPlane` groups one method per S3 surface: the client api-key
 * middleware (§2.1), the two realtime middleware variants (§2.1), the safe
 * mode responses (§2.1), management-plane authorization with the per-IP ban
 * counter (§2.2), the plain OAuth callback routes (§2.4), the management
 * oauth-callback ladder (§2.4), the login-URL endpoints (§2.5) and the
 * session status/cancel endpoints (§2.5). Signatures live in the interface
 * declarations below and are the binding contract; S3 section references
 * are given per method.
 *
 * The harness adapter
 * -------------------
 * `dispatch()` below simulates the routing that runtimes/node will perform
 * in Phase 3 (T1): it maps a recorded request (method + path) onto the
 * matching auth-plane method, merges the middleware's response headers, and
 * stands in for the small number of downstream handlers the goldens touch
 * (models listing, management api-keys listing) with the exact bodies the
 * oracle recorded. Allowed-request bodies are therefore harness-supplied;
 * for those cases the assertions that matter are status and headers (the
 * allow/deny decision) plus the fixed body bytes.
 *
 * Byte-exactness and masking
 * --------------------------
 * Status codes, header name/value sequences and body bytes are compared
 * byte-exactly against the goldens, after applying ONLY the volatility
 * masks each fixture declares in meta.yaml `dynamic_fields`:
 *   - Date header value
 *   - Content-Length value (recomputed for masked bodies)
 *   - X-Cpa-Version / X-Cpa-Commit / X-Cpa-Build-Date / X-Cpa-Support-Plugin
 *     build-info values (presence and position still asserted)
 *   - random session states (JSON field and URL query occurrences)
 *   - PKCE code_challenge values (S256 challenges are 43 base64url chars)
 *   - the ban countdown Go-duration inside the 403 body
 *   - the server port inside Host/redirect_uri positions
 * Deviation from meta.yaml, reported to the orchestrator: the step-1
 * authorize-URL bodies of s3-oauth-session-lifecycle,
 * s3-mgmt-oauth-callback-provider-mismatch and
 * s3-mgmt-oauth-callback-persist-fail contain a random code_challenge that
 * their meta.yaml does NOT list; the mask is applied there based on the
 * token's presence in the golden (same treatment the declared cases get).
 *
 * Header order: the reference transport (Go net/http) writes application
 * headers sorted by name, then Date, Content-Length, Connection. The
 * harness reproduces that emission, so the auth plane only owes the exact
 * header SET (names lowercased by the fetch Headers API; values compared
 * exactly). Transport headers (Date, Content-Length, Connection) and the
 * global CORS block are S1-owned and harness-supplied; X-Cpa-* build
 * headers on management responses are auth-owned (§2.2) and asserted.
 *
 * Replay discipline
 * -----------------
 * Every case replays its recorded steps in order against one shared
 * harness instance per recording instance (meta.yaml `instance`), because
 * the per-IP failure counter, the OAuth session store and safe-mode state
 * are process-lifetime state. The ban pair follows S3 §6 exactly: the two
 * ban fixtures replay back-to-back in one test, against the same fresh-ban
 * instance, reset case first — the four counted failures of the reset
 * case's third step carry over, so the ban case's first request is the
 * fifth cumulative failure (401) and only later requests see the 403 ban
 * body. A standalone replay of the ban case would wrongly expect five 401s.
 *
 * Vendor egress is injected and always fails: the goldens' device-flow
 * cases were recorded with blocked egress (deterministic 500 bodies), and
 * no S3 golden needs successful egress, so the suite runs fully offline
 * and additionally catches any unplanned network call as a golden mismatch.
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'S3')

/* ------------------------------------------------------------------ *
 * Part 1 — contract surface required from @cpa-edge/auth
 * ------------------------------------------------------------------ */

/** Parsed subset of the recording config (from each fixture's meta.yaml). */
export interface AuthPlaneConfig {
  /** Port the server is mounted on; feeds the Devin redirect_uri (§2.3.4). */
  readonly port: number
  /** Top-level api-keys after trim/dedupe normalization; empty list = open mode (§2.1). */
  readonly apiKeys: readonly string[]
  /** Absent when the recording config has no remote-management block at all. */
  readonly remoteManagement?: {
    readonly allowRemote: boolean
    /** Plaintext or bcrypt form; bcrypt form is compared with bcrypt (§2.2, R-BCRYPT). */
    readonly secretKey?: string
  }
  /** Logical auth directory (callback-file publishes report against it). */
  readonly authDir?: string
}

/** Injectable capabilities the auth plane must respect. */
export interface AuthPlaneDeps {
  /**
   * Vendor egress used by the device-code login endpoints (§2.5/§2.6).
   * The harness injects an always-failing fetch (egress-blocked goldens).
   */
  readonly fetch?: typeof fetch
  /** Clock for ban countdowns and session TTLs; epoch milliseconds. */
  readonly now?: () => number
  /** Remote transport address before X-Forwarded-For resolution (§2.2 step 2). */
  readonly remoteAddress?: string
  /**
   * Publishes one OAuth callback handshake record for a pending session
   * (§2.5). Rejection produces the 500 "failed to persist oauth callback"
   * response (§2.4 step 12). Production runtimes bind this to the store.
   */
  readonly publishOauthCallback?: (
    provider: string,
    state: string,
    payload: { code?: string; error?: string; state: string },
  ) => Promise<void>
}

/** Result of the management key middleware (§2.2 pipeline). */
export type ManagementAuthResult =
  | { readonly ok: true; readonly headers: ReadonlyArray<readonly [string, string]> }
  | { readonly ok: false; readonly response: Response }

/** The auth-plane surface this suite drives. */
export interface AuthPlane {
  /** Client api-key middleware for the proxied groups (§2.1): null = allowed. */
  authenticateProxy(request: Request): Promise<Response | null>
  /** Realtime dual middleware: ek_-prefixed secrets first, then api keys (§2.1). */
  authenticateRealtime(request: Request): Promise<Response | null>
  /** Realtime standard middleware: api keys only (§2.1). */
  authenticateRealtimeStandard(request: Request): Promise<Response | null>
  /** Safe-mode 403 for proxied paths; null when safe mode is inactive (§2.1). */
  safeModeProxyResponse(request: Request): Response | null
  /** Safe-mode warning page for GET / and GET /management.html; null when inactive (§2.1). */
  serveSafeModePage(request: Request): Response | null
  /** Whether /v0/management routes are registered at all (§2.2 gating, R-404). */
  managementAvailable(): boolean
  /** Management key middleware: X-Cpa-* headers, ban check, remote gate, key compare (§2.2). */
  authenticateManagement(request: Request): Promise<ManagementAuthResult>
  /** GET /anthropic|codex|antigravity/callback — always 200 success HTML (§2.4). */
  handlePlainCallback(request: Request, provider: 'anthropic' | 'codex' | 'antigravity'): Promise<Response>
  /** GET /callback and /devin/callback — strict validation responses (§2.4). */
  handleDevinCallback(request: Request): Promise<Response>
  /** POST|GET /v0/management/oauth-callback — the §2.4 validation ladder. */
  handleManagementOauthCallback(request: Request): Promise<Response>
  /** GET /v0/management/<provider>-auth-url — code-flow and device-flow login URLs (§2.5, §2.6). */
  handleAuthUrl(request: Request, provider: AuthUrlProvider): Promise<Response>
  /** GET /v0/management/get-auth-status (§2.5). */
  handleGetAuthStatus(request: Request): Promise<Response>
  /** DELETE /v0/management/oauth-session (§2.5). */
  handleOauthSession(request: Request): Promise<Response>
}

export type AuthUrlProvider =
  | 'anthropic'
  | 'codex'
  | 'antigravity'
  | 'devin'
  | 'kimi'
  | 'xai'
  | 'meta'

interface AuthModule {
  createAuthPlane(config: AuthPlaneConfig, deps?: AuthPlaneDeps): AuthPlane
}

/* ------------------------------------------------------------------ *
 * Part 2 — golden fixture parsers (RECIPES layout)
 * ------------------------------------------------------------------ */

interface RecordedRequest {
  method: string
  path: string
  headers: ReadonlyArray<readonly [string, string]>
  body: Uint8Array
}

interface RecordedResponse {
  status: number
  headers: ReadonlyArray<readonly [string, string]>
  body: Uint8Array
}

interface CaseMeta {
  case: string
  instance: string
  instancePort: number
  dynamicFields: ReadonlyArray<string>
  requests: ReadonlyArray<{ file: string; step: number; repeat: number }>
  responses: ReadonlyArray<{ file: string; step: number; repeat: number; status: number }>
  configFragment: string
}

interface CaseStep {
  label: string
  requestFile: string
  responseFile: string
  expectedStatus: number
}

async function readCaseMeta(caseId: string): Promise<CaseMeta> {
  // The oracle writes meta.yaml as JSON-compatible YAML, so strict JSON
  // parsing doubles as a format check.
  const parsed = JSON.parse(await readFile(join(FIXTURES_DIR, caseId, 'meta.yaml'), 'utf8')) as Record<
    string,
    unknown
  >
  const requests = parsed['requests'] as { file: string; step: number; repeat: number }[]
  const responses = parsed['responses'] as { file: string; step: number; repeat: number; status: number }[]
  if (requests.length !== responses.length) {
    throw new Error(`${caseId}: meta.yaml requests/responses length mismatch`)
  }
  return {
    case: asString(parsed['case'], `${caseId} case`),
    instance: asString(parsed['instance'], `${caseId} instance`),
    instancePort: asNumber(parsed['instance_port'], `${caseId} instance_port`),
    dynamicFields: (parsed['dynamic_fields'] as string[]) ?? [],
    requests,
    responses,
    configFragment: asString(parsed['config_fragment'], `${caseId} config_fragment`),
  }
}

async function readRecordedRequest(caseId: string, file: string): Promise<RecordedRequest> {
  const raw = await readFile(join(FIXTURES_DIR, caseId, file))
  const text = new TextDecoder().decode(raw)
  const [head, separator, body] = splitOnce(text, '\r\n\r\n')
  if (!separator) throw new Error(`${caseId}/${file}: missing CRLF header/body separator`)
  const lines = head.split('\r\n')
  const parts = (lines[0] ?? '').split(' ')
  if (parts.length !== 3) throw new Error(`${caseId}/${file}: malformed request line`)
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(': ')
    if (idx < 0) throw new Error(`${caseId}/${file}: malformed header line ${JSON.stringify(line)}`)
    headers.push([line.slice(0, idx), line.slice(idx + 2)])
  }
  return {
    method: parts[0] ?? '',
    path: parts[1] ?? '',
    headers,
    body: new TextEncoder().encode(body),
  }
}

async function readRecordedResponse(caseId: string, file: string): Promise<RecordedResponse> {
  const raw = await readFile(join(FIXTURES_DIR, caseId, file))
  const text = new TextDecoder().decode(raw)
  const statusMatch = /^## Status line\nHTTP\/1\.1 (\d{3}) /m.exec(text)
  if (statusMatch === null) throw new Error(`${caseId}/${file}: missing status line`)
  const status = Number(statusMatch[1])

  const headersStart = text.indexOf('## Response headers (raw, received order)\n')
  if (headersStart < 0) throw new Error(`${caseId}/${file}: missing header section`)
  const headersFrom = headersStart + '## Response headers (raw, received order)\n'.length
  const headersTo = text.indexOf('\n\n## Body', headersFrom)
  if (headersTo < 0) throw new Error(`${caseId}/${file}: missing body section marker`)
  const headers: Array<[string, string]> = []
  for (const line of text.slice(headersFrom, headersTo).split('\n')) {
    const idx = line.indexOf(': ')
    if (idx < 0) throw new Error(`${caseId}/${file}: malformed header line ${JSON.stringify(line)}`)
    headers.push([line.slice(0, idx), line.slice(idx + 2)])
  }

  const bodyMarker = '## Body (exact bytes received, '
  const bodyStart = text.indexOf(bodyMarker)
  if (bodyStart < 0) throw new Error(`${caseId}/${file}: missing body section`)
  const declaredLength = Number((text.slice(bodyStart + bodyMarker.length).match(/^(\d+) bytes\)/) ?? [])[1])
  if (!Number.isInteger(declaredLength)) throw new Error(`${caseId}/${file}: unreadable body length`)
  const fence = text.indexOf('```\n', bodyStart)
  const bodyFrom = fence + '```\n'.length
  const bodyTo = text.indexOf('```', bodyFrom)
  if (fence < 0 || bodyTo < 0) throw new Error(`${caseId}/${file}: unreadable body fences`)
  let bodyText = text.slice(bodyFrom, bodyTo)
  // Bodies that end in a newline are followed by the closing fence on the
  // next line; the strip rule below disambiguates using the declared byte
  // count and is cross-checked by the length assertion.
  if (bodyText.endsWith('\n') && encodeLen(bodyText) - 1 === declaredLength) bodyText = bodyText.slice(0, -1)
  const body = new TextEncoder().encode(bodyText)
  if (body.length !== declaredLength) {
    throw new Error(`${caseId}/${file}: body is ${body.length} bytes, fixture declares ${declaredLength}`)
  }
  return { status, headers, body }
}

function splitOnce(text: string, separator: string): [string, boolean, string] {
  const idx = text.indexOf(separator)
  if (idx < 0) return [text, false, '']
  return [text.slice(0, idx), true, text.slice(idx + separator.length)]
}

function encodeLen(text: string): number {
  return new TextEncoder().encode(text).length
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}: expected a string`)
  return value
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`)
  return value
}

/* ------------------------------------------------------------------ *
 * Part 3 — config fragment parsing (oracle-generated YAML subset)
 * ------------------------------------------------------------------ */

type ConfigValue = string | number | boolean | ReadonlyArray<string> | ConfigRecord
interface ConfigRecord {
  readonly [key: string]: ConfigValue
}

function parseConfigFragment(text: string): ConfigRecord {
  const root: Record<string, ConfigValue> = {}
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    i += 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (line.startsWith('  ')) throw new Error(`config fragment: unexpected indent: ${JSON.stringify(line)}`)
    const s = line.trim()
    const idx = s.indexOf(':')
    if (idx < 0) throw new Error(`config fragment: malformed line ${JSON.stringify(line)}`)
    const key = s.slice(0, idx)
    const inline = s.slice(idx + 1).trim()
    if (inline !== '') {
      root[key] = parseScalar(inline)
      continue
    }
    const block: Record<string, ConfigValue> = {}
    const items: string[] = []
    while (i < lines.length) {
      const next = lines[i]
      if (next.trim() === '' || next.trimStart().startsWith('#')) {
        i += 1
        continue
      }
      if (!next.startsWith('  ')) break
      i += 1
      const ns = next.trim()
      if (ns.startsWith('- ')) {
        items.push(parseScalar(ns.slice(2)) as string)
        continue
      }
      const nidx = ns.indexOf(':')
      if (nidx < 0) throw new Error(`config fragment: malformed nested line ${JSON.stringify(next)}`)
      block[ns.slice(0, nidx)] = parseScalar(ns.slice(nidx + 1).trim())
    }
    root[key] = items.length > 0 ? items : block
  }
  return root
}

function parseScalar(token: string): Exclude<ConfigValue, ConfigRecord | ReadonlyArray<string>> {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1)
  if (token === 'true') return true
  if (token === 'false') return false
  if (/^-?\d+$/.test(token)) return Number(token)
  return token
}

/* ------------------------------------------------------------------ *
 * Part 4 — volatility masking (meta.yaml dynamic_fields only)
 * ------------------------------------------------------------------ */

interface MaskSet {
  date: boolean
  contentLength: boolean
  xCpaBuild: boolean
  state: boolean
  codeChallenge: boolean
  banRemaining: boolean
  port: boolean
}

const XCPA_BUILD_HEADERS = new Set([
  'x-cpa-version',
  'x-cpa-commit',
  'x-cpa-build-date',
  'x-cpa-support-plugin',
])

function maskSetFor(meta: CaseMeta, expectedBodies: ReadonlyArray<Uint8Array>): MaskSet {
  const declared = meta.dynamicFields.map((entry) => entry.toLowerCase()).join('\n')
  return {
    date: declared.includes('date'),
    contentLength: declared.includes('content-length'),
    xCpaBuild: declared.includes('x-cpa'),
    state: declared.includes('$s') || declared.includes('state'),
    codeChallenge:
      declared.includes('code_challenge') ||
      expectedBodies.some((body) => bufferContains(body, 'code_challenge=')),
    banRemaining: declared.includes('ban countdown'),
    port: declared.includes('instance port'),
  }
}

function bufferContains(haystack: Uint8Array, needle: string): boolean {
  const decoded = new TextDecoder().decode(haystack)
  return decoded.includes(needle)
}

function maskHeaderValue(name: string, value: string, masks: MaskSet): string {
  const lowered = name.toLowerCase()
  if (masks.date && lowered === 'date') return '{{DATE}}'
  if (masks.contentLength && lowered === 'content-length') return '{{CONTENT-LENGTH}}'
  if (masks.xCpaBuild && XCPA_BUILD_HEADERS.has(lowered)) return `{{${lowered}}}`
  return value
}

function maskBodyText(text: string, masks: MaskSet): string {
  let out = text
  if (masks.banRemaining) {
    out = out.replace(/(Try again in )([^"}]+)/g, '$1{{BAN-REMAINING}}')
  }
  if (masks.state) {
    out = out.replace(/"state":"([0-9a-f]{32})"/g, '"state":"{{STATE}}"')
    out = out.replace(/(\\u0026|[?&])state=([0-9a-f]{32})/g, '$1state={{STATE}}')
  }
  if (masks.codeChallenge) {
    out = out.replace(/code_challenge=([A-Za-z0-9_-]{43})/g, 'code_challenge={{CODE_CHALLENGE}}')
  }
  if (masks.port) {
    out = out.replace(/(127\.0\.0\.1(?::|%3A))\d+/g, '$1{{PORT}}')
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Part 5 — harness adapter (simulates the Phase-3 runtime mount)
 * ------------------------------------------------------------------ */

const CORS_BLOCK: ReadonlyArray<readonly [string, string]> = [
  ['Access-Control-Allow-Headers', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  ['Access-Control-Allow-Origin', '*'],
  [
    'Access-Control-Expose-Headers',
    'X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, ' +
      'X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, ' +
      'Location, Retry-After, X-Request-Id, OpenAI-Request-Id',
  ],
]

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

/** A fully composed downstream response, in reference emission order. */
interface ComposedResponse {
  status: number
  headers: ReadonlyArray<readonly [string, string]>
  body: Uint8Array
}

async function composeDownstream(
  app: Response,
  extraHeaders: ReadonlyArray<readonly [string, string]> = [],
): Promise<ComposedResponse> {
  const body = new Uint8Array(await app.arrayBuffer())
  const byName = new Map<string, string>()
  for (const [name, value] of app.headers) byName.set(name.toLowerCase(), value)
  for (const [name, value] of extraHeaders) {
    const lowered = name.toLowerCase()
    if (!byName.has(lowered)) byName.set(lowered, value)
  }
  const sorted = [...byName.entries()]
    .map(([name, value]) => [name, value] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const headers: Array<[string, string]> = [
    ...CORS_BLOCK,
    ...sorted,
    ['Date', new Date().toUTCString()],
    ['Content-Length', String(body.length)],
    ['Connection', 'close'],
  ]
  return { status: app.status, headers, body }
}

function jsonOk(bodyText: string): Response {
  return new Response(bodyText, { status: 200, headers: { 'Content-Type': JSON_CONTENT_TYPE } })
}

/** Stand-in for the S1/S5 handlers the goldens reach after a successful auth. */
function proxySuccessResponse(path: string): Response | null {
  if (path === '/v1/models') return jsonOk('{"data":[],"object":"list"}')
  if (path === '/v1beta/models') return jsonOk('{"models":[]}')
  return null
}

function isProxiedPath(path: string): boolean {
  return (
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path === '/v1beta' ||
    path.startsWith('/v1beta/') ||
    path === '/openai/v1' ||
    path.startsWith('/openai/v1/') ||
    path === '/backend-api/codex' ||
    path.startsWith('/backend-api/codex/')
  )
}

/** §2.1 realtime route split: which middleware variant owns the route. */
function realtimeVariant(path: string, method: string): 'dual' | 'standard' | null {
  if (method === 'POST') {
    if (
      path === '/v1/realtime/client_secrets' ||
      path === '/v1/realtime/sessions' ||
      path === '/v1/realtime/transcription_sessions' ||
      path === '/v1/realtime/translations/client_secrets'
    ) {
      return 'standard'
    }
    if (/^\/v1\/realtime\/calls\/[^/]+\/(hangup|accept|reject|refer)$/.test(path)) return 'standard'
    if (path === '/v1/realtime' || path === '/v1/realtime/calls') return 'dual'
  }
  if (method === 'GET') {
    if (path === '/v1/realtime') return 'dual'
    if (/^\/v1\/realtime\/calls\/[^/]+$/.test(path)) return 'dual'
    if (path === '/v1/realtime/translations') return 'dual'
  }
  return null
}

const PLAIN_CALLBACKS: Readonly<Record<string, 'anthropic' | 'codex' | 'antigravity'>> = {
  '/anthropic/callback': 'anthropic',
  '/codex/callback': 'codex',
  '/antigravity/callback': 'antigravity',
}

const AUTH_URL_PROVIDERS: ReadonlyArray<AuthUrlProvider> = [
  'anthropic',
  'codex',
  'antigravity',
  'devin',
  'kimi',
  'xai',
  'meta',
]

interface HarnessInstance {
  plane: AuthPlane
  port: number
  apiKeys: ReadonlyArray<string>
}

async function dispatch(instance: HarnessInstance, request: Request): Promise<ComposedResponse> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method
  const plane = instance.plane

  // Safe-mode warning pages for the two documented GET paths (§2.1).
  if (method === 'GET' && (path === '/' || path === '/management.html')) {
    const page = callPlane(plane, 'serveSafeModePage', request)
    if (page === null) {
      throw new Error(`harness: GET ${path} reached the non-safe-mode root handler; no golden covers it`)
    }
    return composeDownstream(page)
  }

  // Proxied route groups (§2.1).
  if (isProxiedPath(path)) {
    const blocked = callPlane(plane, 'safeModeProxyResponse', request)
    if (blocked !== null) return composeDownstream(blocked)
    const variant = realtimeVariant(path, method)
    if (variant === 'dual') {
      const rejection = await callPlane(plane, 'authenticateRealtime', request)
      if (rejection !== null) return composeDownstream(rejection)
    } else if (variant === 'standard') {
      const rejection = await callPlane(plane, 'authenticateRealtimeStandard', request)
      if (rejection !== null) return composeDownstream(rejection)
    } else {
      const rejection = await callPlane(plane, 'authenticateProxy', request)
      if (rejection !== null) return composeDownstream(rejection)
    }
    const success = proxySuccessResponse(path)
    if (success === null) {
      throw new Error(`harness: no downstream stand-in for allowed ${method} ${path}`)
    }
    return composeDownstream(success)
  }

  // Plain OAuth callback routes on the main port (§2.4).
  const plainProvider = PLAIN_CALLBACKS[path]
  if (method === 'GET' && plainProvider !== undefined) {
    return composeDownstream(await callPlane(plane, 'handlePlainCallback', request, plainProvider))
  }
  if (method === 'GET' && (path === '/callback' || path === '/devin/callback')) {
    return composeDownstream(await callPlane(plane, 'handleDevinCallback', request))
  }

  // Management plane (§2.2 gating first: unconfigured -> R-404 empty body).
  if (path === '/v0/management' || path.startsWith('/v0/management/')) {
    if (!callPlane(plane, 'managementAvailable')) {
      return composeDownstream(new Response(null, { status: 404 }))
    }
    if (method === 'GET' || method === 'POST') {
      if (path === '/v0/management/oauth-callback') {
        // Registered in the management group WITHOUT the key middleware (§2.4):
        // no X-Cpa-* headers are added on this route.
        return composeDownstream(await callPlane(plane, 'handleManagementOauthCallback', request))
      }
    }
    const verdict = await callPlane(plane, 'authenticateManagement', request)
    if (!verdict.ok) return composeDownstream(verdict.response)
    const extra = [...verdict.headers]

    if (method === 'GET' && path === '/v0/management/api-keys') {
      // S5-owned listing; harness stand-in with the recorded bytes.
      return composeDownstream(
        jsonOk(JSON.stringify({ 'api-keys': instance.apiKeys.map((key) => key) })),
        extra,
      )
    }
    for (const provider of AUTH_URL_PROVIDERS) {
      if (method === 'GET' && path === `/v0/management/${provider}-auth-url`) {
        return composeDownstream(await callPlane(plane, 'handleAuthUrl', request, provider), extra)
      }
    }
    if (method === 'GET' && path === '/v0/management/get-auth-status') {
      return composeDownstream(await callPlane(plane, 'handleGetAuthStatus', request), extra)
    }
    if (method === 'DELETE' && path === '/v0/management/oauth-session') {
      return composeDownstream(await callPlane(plane, 'handleOauthSession', request), extra)
    }
    throw new Error(`harness: management sub-route ${method} ${path} has no golden stand-in`)
  }

  throw new Error(`harness: ${method} ${path} is not mounted by the S3 contract adapter`)
}

/** Invokes an auth-plane method, failing with a contract-shaped message when absent. */
function callPlane<MethodName extends keyof AuthPlane>(
  plane: AuthPlane,
  method: MethodName,
  ...args: unknown[]
): AuthPlane[MethodName] extends (...parameters: never[]) => infer Result
  ? Result extends Promise<infer Awaited>
    ? Awaited
    : Result
  : never
{
  const candidate: unknown = (plane as Record<string, unknown>)[method]
  if (typeof candidate !== 'function') {
    throw new Error(
      `@cpa-edge/auth auth plane method '${String(method)}' is missing (S3 contract requires it); ` +
        `createAuthPlane returned an object without it`,
    )
  }
  return (candidate as (...parameters: unknown[]) => unknown)(...args) as never
}

/* ------------------------------------------------------------------ *
 * Part 6 — module loading, instance registry, replay engine
 * ------------------------------------------------------------------ */

let authFactory: ((config: AuthPlaneConfig, deps?: AuthPlaneDeps) => AuthPlane) | null = null
let loadFailure: string | null = null

beforeAll(async () => {
  try {
    const moduleNamespace = (await import('@cpa-edge/auth')) as Record<string, unknown>
    const candidate = moduleNamespace['createAuthPlane']
    if (typeof candidate !== 'function') {
      loadFailure =
        '@cpa-edge/auth does not export createAuthPlane(config, deps) yet ' +
        '(the current empty index is the expected Phase-1 state)'
      return
    }
    authFactory = candidate as (config: AuthPlaneConfig, deps?: AuthPlaneDeps) => AuthPlane
  } catch (error) {
    loadFailure = `importing @cpa-edge/auth failed: ${String(error)}`
  }
})

function requireFactory(): (config: AuthPlaneConfig, deps?: AuthPlaneDeps) => AuthPlane {
  if (loadFailure !== null) {
    throw new Error(
      `S3 contract suite is red pending the @cpa-edge/auth implementation: ${loadFailure}. ` +
        `Every case below replays a golden from tests/fixtures/S3 once the export exists.`,
    )
  }
  if (authFactory === null) {
    throw new Error('S3 contract suite: auth factory vanished between setup and test')
  }
  return authFactory
}

const instances = new Map<string, HarnessInstance>()

async function instanceFor(meta: CaseMeta): Promise<HarnessInstance> {
  const existing = instances.get(meta.instance)
  if (existing !== undefined) return existing
  const config = parseConfigFragment(meta.configFragment)
  const port = asNumber(config['port'], `${meta.instance} port`)
  if (port !== meta.instancePort) {
    throw new Error(`${meta.case}: config port ${port} disagrees with meta instance_port ${meta.instancePort}`)
  }
  const apiKeysRaw = config['api-keys']
  const apiKeys: ReadonlyArray<string> =
    apiKeysRaw === undefined ? [] : (apiKeysRaw as ReadonlyArray<string>)
  const remoteRaw = config['remote-management'] as ConfigRecord | undefined
  const planeConfig: AuthPlaneConfig = {
    port,
    apiKeys,
    remoteManagement:
      remoteRaw === undefined
        ? undefined
        : {
            allowRemote: remoteRaw['allow-remote'] === true,
            secretKey: typeof remoteRaw['secret-key'] === 'string' ? remoteRaw['secret-key'] : undefined,
          },
    authDir: typeof config['auth-dir'] === 'string' ? config['auth-dir'] : undefined,
  }
  const deps: AuthPlaneDeps = {
    // Egress always fails: device-flow goldens are the egress-blocked ones,
    // and unplanned egress must surface as a mismatch, not as a hang.
    fetch: () => Promise.reject(new Error('egress blocked (harness)')),
    remoteAddress: '127.0.0.1',
    publishOauthCallback:
      meta.instance === 'default-readonly-authdir'
        ? () => Promise.reject(new Error('auth dir mounted read-only (harness)'))
        : () => Promise.resolve(),
  }
  const plane = requireFactory()(planeConfig, deps)
  const handle: HarnessInstance = { plane, port, apiKeys }
  instances.set(meta.instance, handle)
  return handle
}

function buildRequest(recorded: RecordedRequest, port: number): Request {
  const headers = new Headers()
  for (const [name, value] of recorded.headers) {
    if (name === 'Host' || name === 'Connection' || name === 'Content-Length') continue
    headers.append(name, value)
  }
  return new Request(`http://127.0.0.1:${port}${recorded.path}`, {
    method: recorded.method,
    headers,
    body: recorded.body.length > 0 ? new Uint8Array(recorded.body) : undefined,
  })
}

function headerLines(
  headers: ReadonlyArray<readonly [string, string]>,
  masks: MaskSet,
): string[] {
  return headers.map(
    ([name, value]) => `${name.toLowerCase()}: ${maskHeaderValue(name, value, masks)}`,
  )
}

function describeDifference(
  caseId: string,
  stepLabel: string,
  expected: RecordedResponse,
  actual: ComposedResponse,
  masks: MaskSet,
): void {
  const problems: string[] = []
  if (expected.status !== actual.status) {
    problems.push(`status: expected ${expected.status}, actual ${actual.status}`)
  }
  const expectedHeaders = headerLines(expected.headers, masks)
  const actualHeaders = headerLines(actual.headers, masks)
  const headerProblem = firstDifference(expectedHeaders, actualHeaders)
  if (headerProblem !== null) problems.push(`headers: ${headerProblem}`)
  const expectedBody = maskBodyText(new TextDecoder().decode(expected.body), masks)
  const actualBody = maskBodyText(new TextDecoder().decode(actual.body), masks)
  if (expectedBody !== actualBody) {
    const byte = firstDifferingByte(expectedBody, actualBody)
    problems.push(
      `body: expected (${expectedBody.length} chars) !== actual (${actualBody.length} chars); ` +
        `first difference at char ${byte}\n    expected: ${JSON.stringify(expectedBody)}\n    actual:   ${JSON.stringify(actualBody)}`,
    )
  }
  if (problems.length === 0) return
  throw new Error(`[${caseId}] step ${stepLabel} diverges from the golden:\n  - ${problems.join('\n  - ')}`)
}

function firstDifference(expected: string[], actual: string[]): string | null {
  if (expected.length === actual.length && expected.every((line, i) => line === actual[i])) return null
  let index = 0
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index += 1
  const from = Math.max(0, index - 2)
  const context = (lines: string[]): string =>
    lines
      .slice(from, index + 3)
      .map((line, offset) => `        ${String(from + offset).padStart(2)}: ${line}`)
      .join('\n')
  return `first divergence at index ${index}\n      expected:\n${context(expected)}\n      actual:\n${context(actual)}`
}

function firstDifferingByte(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) return i
  }
  return limit
}

async function replayCase(caseId: string): Promise<void> {
  // Guard first: while @cpa-edge/auth has no implementation every case must
  // fail with the canonical red-state message, not with incidental details.
  requireFactory()
  const meta = await readCaseMeta(caseId)
  const instance = await instanceFor(meta)
  const steps: CaseStep[] = meta.requests.map((entry, i) => {
    const response = meta.responses[i]
    if (response === undefined) throw new Error(`${caseId}: response record ${i} missing`)
    if (entry.step !== response.step || entry.repeat !== response.repeat) {
      throw new Error(`${caseId}: request/response step ordering mismatch at ${i}`)
    }
    return {
      label: `${entry.step}${entry.repeat > 1 ? `r${entry.repeat}` : ''}`,
      requestFile: entry.file,
      responseFile: response.file,
      expectedStatus: response.status,
    }
  })
  const expectedBodies = await Promise.all(
    steps.map((step) => readRecordedResponse(caseId, step.responseFile).then((entry) => entry.body)),
  )
  const masks = maskSetFor(meta, expectedBodies)

  let recordedState: string | null = null
  let liveState: string | null = null
  for (const step of steps) {
    const recorded = await readRecordedRequest(caseId, step.requestFile)
    let pathText = recorded.path
    let bodyText = new TextDecoder().decode(recorded.body)
    if (recordedState !== null && liveState !== null) {
      pathText = pathText.split(recordedState).join(liveState)
      bodyText = bodyText.split(recordedState).join(liveState)
    }
    const request = buildRequest(
      { ...recorded, path: pathText, body: new TextEncoder().encode(bodyText) },
      instance.port,
    )
    const actual = await dispatch(instance, request)
    const expected = await readRecordedResponse(caseId, step.responseFile)

    // State capture for multi-step cases (meta.yaml state_capture / $S):
    // the authorize-URL response's state substitutes into later requests.
    if (recordedState === null) {
      const recordedMatch = /"state":"([0-9a-f]{32})"/.exec(new TextDecoder().decode(expected.body))
      const liveMatch = /"state":"([0-9a-f]{32})"/.exec(new TextDecoder().decode(actual.body))
      if (recordedMatch !== null && liveMatch !== null) {
        recordedState = recordedMatch[1] ?? null
        liveState = liveMatch[1] ?? null
      }
    }

    if (actual.status !== step.expectedStatus) {
      throw new Error(
        `[${caseId}] step ${step.label}: meta.yaml declares status ${step.expectedStatus}, ` +
          `harness produced ${actual.status} (see the golden diff that follows for details)`,
      )
    }
    describeDifference(caseId, step.label, expected, actual, masks)
  }
}

/* ------------------------------------------------------------------ *
 * Part 7 — case registry (the fixture -> test coverage map)
 * ------------------------------------------------------------------ */

const CASES: ReadonlyArray<Readonly<{ id: string; group: string; summary: string }>> = [
  // client api-key matrix (§2.1)
  { id: 's3-apikey-missing', group: 'client', summary: 'no credential -> 401 {"error":"Missing API key"}' },
  { id: 's3-apikey-invalid-bearer', group: 'client', summary: 'wrong Bearer -> 401 {"error":"Invalid API key"}' },
  { id: 's3-apikey-valid-bearer', group: 'client', summary: 'valid Bearer -> 200 (allowed)' },
  {
    id: 's3-apikey-raw-authorization',
    group: 'client',
    summary: 'Authorization without Bearer prefix compares the whole value',
  },
  { id: 's3-apikey-x-goog', group: 'client', summary: 'x-goog-api-key accepted on /v1beta' },
  { id: 's3-apikey-x-api-key', group: 'client', summary: 'X-Api-Key accepted on /v1' },
  { id: 's3-apikey-query-key', group: 'client', summary: 'query key=... accepted' },
  { id: 's3-apikey-query-auth-token', group: 'client', summary: 'query auth_token=... accepted' },
  {
    id: 's3-apikey-open-when-unconfigured',
    group: 'client',
    summary: 'empty api-keys list -> open mode, request allowed',
  },
  {
    id: 's3-safemode-example-key',
    group: 'client',
    summary: 'template api-key -> 403 + X-Cpa-Safe-Mode; GET / serves the warning page',
  },
  // realtime auth shapes (§2.1)
  { id: 's3-realtime-unauth', group: 'realtime', summary: 'POST /v1/realtime/sessions no key -> 401 realtime shape' },
  {
    id: 's3-realtime-invalid-key',
    group: 'realtime',
    summary: 'wrong Bearer -> 401 realtime invalid_api_key shape',
  },
  {
    id: 's3-realtime-ek-invalid-secret',
    group: 'realtime',
    summary: 'ek_-prefixed garbage on GET /v1/realtime -> 401 invalid_realtime_client_secret',
  },
  // management authorization singles (§2.2)
  { id: 's3-mgmt-valid-x-management-key', group: 'mgmt', summary: 'valid X-Management-Key -> 200' },
  { id: 's3-mgmt-valid-bearer', group: 'mgmt', summary: 'valid Bearer management key -> 200' },
  { id: 's3-mgmt-missing-key', group: 'mgmt', summary: 'no key -> 401 missing management key' },
  { id: 's3-mgmt-invalid-key', group: 'mgmt', summary: 'wrong key -> 401 invalid management key' },
  {
    id: 's3-mgmt-remote-disabled',
    group: 'mgmt',
    summary: 'XFF 10.0.0.99 -> 403 remote management disabled; XFF 127.0.0.1 -> 200',
  },
  {
    id: 's3-mgmt-unconfigured-404',
    group: 'mgmt',
    summary: 'no secret configured -> route unregistered -> R-404 empty body',
  },
  // plain OAuth callback routes (§2.4)
  {
    id: 's3-oauth-callback-anthropic-unknown-state',
    group: 'callback',
    summary: 'GET /anthropic/callback unknown state -> 200 success HTML',
  },
  {
    id: 's3-oauth-callback-codex-unknown-state',
    group: 'callback',
    summary: 'GET /codex/callback with error param -> 200 success HTML',
  },
  {
    id: 's3-oauth-callback-devin-missing',
    group: 'callback',
    summary: 'GET /devin/callback without code/error -> 400 JSON',
  },
  {
    id: 's3-oauth-callback-devin-unknown',
    group: 'callback',
    summary: 'GET /devin/callback unknown state -> 400 invalid or expired OAuth callback',
  },
  // management oauth-callback ladder (§2.4)
  {
    id: 's3-mgmt-oauth-callback-invalid-body',
    group: 'mgmt-callback',
    summary: 'unparseable POST body -> 400 {"error":"invalid body","status":"error"}',
  },
  {
    id: 's3-mgmt-oauth-callback-missing-state',
    group: 'mgmt-callback',
    summary: 'no state -> 400 {"error":"state is required","status":"error"}',
  },
  {
    id: 's3-mgmt-oauth-callback-invalid-state',
    group: 'mgmt-callback',
    summary: 'state "bad state!" -> 400 {"error":"invalid state","status":"error"}',
  },
  {
    id: 's3-mgmt-oauth-callback-missing-code',
    group: 'mgmt-callback',
    summary: 'GET without code/error -> 400 {"error":"code or error is required","status":"error"}',
  },
  {
    id: 's3-mgmt-oauth-callback-unknown-state',
    group: 'mgmt-callback',
    summary: 'well-formed unknown state -> 404 {"error":"unknown or expired state","status":"error"}',
  },
  {
    id: 's3-mgmt-oauth-callback-invalid-redirect-url',
    group: 'mgmt-callback',
    summary: 'unparseable redirect_url -> 400 {"error":"invalid redirect_url","status":"error"}',
  },
  {
    id: 's3-mgmt-oauth-callback-provider-mismatch',
    group: 'mgmt-callback',
    summary: 'codex session + provider anthropic -> 400 provider does not match state',
  },
  {
    id: 's3-mgmt-oauth-callback-persist-fail',
    group: 'mgmt-callback',
    summary: 'pending session + failing callback publish -> 500 failed to persist oauth callback',
  },
  // login-URL endpoints (§2.5)
  { id: 's3-auth-url-anthropic', group: 'auth-url', summary: 'Claude authorize URL (query set + order)' },
  { id: 's3-auth-url-codex', group: 'auth-url', summary: 'Codex authorize URL (extra params)' },
  { id: 's3-auth-url-antigravity', group: 'auth-url', summary: 'Google authorize URL (5 scopes)' },
  {
    id: 's3-auth-url-devin',
    group: 'auth-url',
    summary: 'Devin authorize URL (hand-built query order, server port redirect_uri)',
  },
  {
    id: 's3-device-auth-url-egress-blocked-kimi',
    group: 'auth-url',
    summary: 'egress failure -> 500 failed to generate authorization url',
  },
  {
    id: 's3-device-auth-url-egress-blocked-xai',
    group: 'auth-url',
    summary: 'egress failure -> 500 failed to start device authorization flow',
  },
  {
    id: 's3-device-auth-url-egress-blocked-meta',
    group: 'auth-url',
    summary: 'egress failure -> 500 failed to start device authorization flow',
  },
  // session lifecycle, status and cancel (§2.5)
  {
    id: 's3-oauth-session-lifecycle',
    group: 'session',
    summary: 'auth-url -> wait -> cancel -> unknown -> callback 404, state substituted per step',
  },
  { id: 's3-get-auth-status-empty', group: 'session', summary: 'no state param -> 200 {"status":"ok"}' },
  {
    id: 's3-get-auth-status-invalid-state',
    group: 'session',
    summary: 'bad/state -> 400 {"error":"invalid state","status":"error"}',
  },
  {
    id: 's3-cancel-session-missing-state',
    group: 'session',
    summary: 'DELETE without state -> 400 {"error":"missing state","status":"error"}',
  },
]

describe('S3 auth-plane golden contract (tests/fixtures/S3)', () => {
  beforeAll(async () => {
    // The module-level beforeAll already ran the import; nothing else to do.
  })

  it('fixture set matches the case registry exactly', async () => {
    await requireFactory()
    const onDisk = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const registered = CASES.map((entry) => entry.id)
      .concat(['s3-mgmt-ban-reset-on-success', 's3-mgmt-ban-after-5-invalid'])
      .sort()
    expect(onDisk).toEqual(registered)
  })

  describe('client api-key middleware (§2.1)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'client') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })

  describe('realtime auth variants (§2.1)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'realtime') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })

  describe('management authorization (§2.2)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'mgmt') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })

  describe('ban pair, S3 §6 replay discipline (shared fresh-ban instance, reset case first)', () => {
    it('s3-mgmt-ban-reset-on-success then s3-mgmt-ban-after-5-invalid — counter carry-over [401×4,200,401×4] then [401,403×5]', async () => {
      // The per-IP failure counter is cumulative for the process lifetime.
      // The reset case's four failures of its last step carry over, so the
      // ban case's first request is cumulative failure #5 (answered 401);
      // every following request — including the one bearing a VALID key —
      // is answered with the 403 ban body. Both fixtures must replay in
      // this order against the same instance, per S3 §6.
      await replayCase('s3-mgmt-ban-reset-on-success')
      await replayCase('s3-mgmt-ban-after-5-invalid')
    })
  })

  describe('plain OAuth callback routes (§2.4)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'callback') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })

  describe('management oauth-callback ladder (§2.4)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'mgmt-callback') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })

  describe('login-URL endpoints (§2.5, §2.6)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'auth-url') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })

  describe('OAuth session lifecycle, status and cancel (§2.5)', () => {
    for (const definition of CASES) {
      if (definition.group !== 'session') continue
      it(`${definition.id} — ${definition.summary}`, async () => {
        await replayCase(definition.id)
      })
    }
  })
})

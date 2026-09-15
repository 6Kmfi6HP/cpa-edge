/**
 * S2d3 golden contract — OpenAI Chat Completions client → Claude (Anthropic Messages) upstream.
 *
 * Spec source of truth: spec/sections/S2d3-oai2cla.md (admitted). Goldens: the 26 recorded
 * fixture cases under tests/fixtures/S2d3/ (oracle recordings of CLIProxyAPI v7.3.4 against
 * the deterministic claude mock). Rulings applied: R-SSE (decoded event sequences, never
 * chunk boundaries), R-ORDER (adjacent tool_calls delta frames compare as sorted multisets),
 * NE-LENIENT (fixtures replay well-formed bodies only), R-FIXTURE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/oai2cla` direction module MUST export.
 * The suite dynamically imports the package and turns green-to-red once the export ships;
 * while the package is still a skeleton every case test SKIPS with the reason below. The
 * harness holds its own structural mirror of these types; the package should export the
 * real ones. All shapes are runtime-checked by the suite.
 *
 *   export function createOai2ClaChatService(options: Oai2ClaServiceOptions): Oai2ClaChatService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Oai2ClaModelEntry {
 *     name: string                    // upstream model name (alias target)
 *     alias?: string                  // client-facing alias; "cm(4096)" suffix is parsed + stripped
 *     isCompat?: boolean             // compat request translation (assistant thinking history)
 *     thinking?: { min?: number; max?: number; levels?: readonly string[] }
 *   }
 *
 *   interface Oai2ClaCredential {
 *     apiKey: string
 *     baseUrl: string                 // e.g. "http://host.docker.internal:20002"
 *     headers?: Readonly<Record<string, string>>
 *     fingerprintProfile?: 'claude-code-cli'   // switches the credential to the CLI wire profile
 *     models: readonly Oai2ClaModelEntry[]
 *   }
 *
 *   interface Oai2ClaServiceOptions {
 *     credentials: readonly Oai2ClaCredential[] // claude-api-key entries, config order
 *     gatewayVersion: string          // default upstream User-Agent: `CLIProxyAPI/${gatewayVersion}`
 *     store: Store                     // from @cpa-edge/core; ALL persistent state (cooldowns) flows through it
 *     now?: () => number               // epoch-ms clock; MUST be used for every timing decision
 *     requestRetry?: number            // 0 in every S2d3 fixture (no retries)
 *     transientErrorCooldownSeconds?: number  // -1 (disabled) in every S2d3 fixture
 *   }
 *
 *   interface Oai2ClaChatRequest {
 *     method: string                   // 'POST'
 *     path: string                     // '/v1/chat/completions'
 *     headers: HeaderList             // client headers, recorded order + casing
 *     body: string                     // exact request-body bytes (well-formed JSON per NE-LENIENT)
 *   }
 *
 *   interface Oai2ClaUpstreamRequest {
 *     method: string                   // 'POST'
 *     url: string                      // absolute: `${baseUrl}/v1/messages?beta=true` (beta=true ALWAYS)
 *     headers: HeaderList              // emission ORDER is pinned (see "Comparison rules")
 *     body: string
 *   }
 *
 *   interface Oai2ClaUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array> // 2xx: SSE bytes; otherwise raw bytes.
 *                                       // A rejected read mid-body models an upstream disconnect.
 *   }
 *
 *   type Oai2ClaUpstreamSender =
 *     (request: Oai2ClaUpstreamRequest) => Promise<Oai2ClaUpstreamResponse>
 *
 *   interface Oai2ClaChatResponse {
 *     status: number
 *     headers: HeaderList              // must carry the direction-owned subset (see below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Oai2ClaChatService {
 *     handleChatCompletions(
 *       request: Oai2ClaChatRequest,
 *       send: Oai2ClaUpstreamSender,
 *     ): Promise<Oai2ClaChatResponse>
 *   }
 *
 * The facade covers the whole pinned direction pipeline: request translation (spec §2.4),
 * executor post-processing (§2.5), upstream header policy (§2.3), response mapping (§3),
 * downstream SSE framing + stream bootstrap gate (§4), error semantics (§5, including the
 * 429→credential-cooldown slice of §5.4) and aggregation validation (§5.3). Internals may
 * compose the claude executor and core scheduling primitives; only this facade is contract.
 * OUT of scope here (owned by S1 and asserted by no fixture in this suite): client auth,
 * CORS headers, R-404 routing, Date/X-Cpa-Trace-Id/Content-Length/Connection emission.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Per case the harness builds a fresh service + fresh MemoryStore (cooldown pairs 14/26
 *   share them WITHIN the case; cases are mutually isolated, so recording-order
 *   constraints like "run case 14 last" do not apply to replay).
 * • The clock is frozen (`now()` returns a constant) so the ~1s / fuzz-derived cooldowns
 *   of cases 14/26 stay deterministic: step 2 always lands inside the cooldown window.
 * • The harness plays the mock upstream from each case's mock-response.json control files
 *   (one control per step) + the canned event scripts embedded below, transcribed from
 *   spec/recordings/S2d3.cases.json (`scripts_needed` + follow-up batch). $MODEL is
 *   substituted from the translated upstream body's `model` field, $STOP_REASON from the
 *   control file. Modes: happy (SSE script), error (status + error_body serialized with
 *   Python json.dumps spacing, because the recorded verbatim 429 passthrough bytes use
 *   that spacing — or raw_body verbatim), disconnect (hard stream abort after N events,
 *   surfacing as a rejected read), slow (inter-event delay).
 * • Upstream calls are captured; at the end of a case the captured sequence must equal
 *   the recorded upstream.jsonl lines (count + bytes). Cooldown steps (14/26 step 2)
 *   therefore also pin "no upstream call is made".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (baseUrl + recorded path), body: byte-exact after masking.
 *   - headers: the full ordered list, names case-preserved. Two transport artifacts are
 *     excluded from the ordered compare: `Content-Length` (derived from body bytes; if
 *     the adapter emits it, it must equal the body byte length) and recording-only
 *     `ts`/`type` fields of upstream.jsonl (not part of the wire request).
 *   - `Authorization` is redacted in the recordings; the adapter's value must start with
 *     "Bearer " and is then normalized to "<redacted>" (spec §2.3: name + prefix pinned).
 *
 * Downstream (per step):
 *   - status: exact. Body: byte-exact after masking — SSE bodies compare as DECODED
 *     event sequences per R-SSE: the ordered list of `data: ` payloads plus the terminal
 *     `data: [DONE]`; raw chunk boundaries are ignored, and `event:` lines must NOT
 *     appear downstream (§4.6).
 *   - R-ORDER: a maximal run of adjacent tool_calls delta frames compares as a sorted
 *     multiset; every other frame is order-pinned. (In the recorded S2d3 goldens each
 *     such run has length 1, so this allowance changes nothing today.)
 *   - headers: only the direction-owned subset is asserted: `Content-Type` (exact),
 *     `Cache-Control` (exact when the recorded response is SSE, absent otherwise),
 *     `Retry-After` (exact / masked-fuzz when present, absent when the recording has
 *     none). Absence is asserted, which pins "no SSE headers before commit" for the
 *     pre-commit failure cases (14/15/16-2/17-2/23/24/25/26).
 *
 * MASKS — applied identically to recorded and produced bytes, derived from each case's
 * meta.yaml `dynamic_fields` (unknown entries fail the suite loudly so new volatility
 * must be added consciously):
 *   - Date: HTTP Date values are not compared; inside bodies the cloaked date-context
 *     sentence "Today's date is YYYY-MM-DD." is masked (case 21).
 *   - X-Cpa-Trace-Id: never reaches a compared surface; declared for completeness.
 *   - created: `"created":<epoch>` in JSON bodies/chunks → "<EPOCH>".
 *   - mock port: trailing `:port` of the upstream Host header → ":<PORT>".
 *   - UUID (case 21): UUID-shaped values and the 64-hex `device_id` inside the CLI-profile
 *     metadata.user_id JSON are masked; the surrounding JSON structure stays byte-pinned.
 *   - Retry-After fuzz (case 26): cooldown `Retry-After`, `reset_seconds`, `reset_time`
 *     values are masked. Case 14 is the deliberate exception: its scripted 429 carries NO
 *     upstream reset header, and spec §5.4 pins the literals `Retry-After: 1`,
 *     `"reset_seconds":1`, `"reset_time":"1s"` — those assert byte-exact.
 *   - metadata.user_id sha256 derivations are NOT masked (deterministic; byte-pinned).
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/oai2cla'
const ADAPTER_EXPORT = 'createOai2ClaChatService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
  readonly isCompat?: boolean
  readonly thinking?: { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] }
}

interface CredentialConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly fingerprintProfile?: string
  readonly models: readonly ModelEntry[]
}

interface ServiceOptions {
  readonly credentials: readonly CredentialConfig[]
  readonly gatewayVersion: string
  readonly store: Store
  readonly now: () => number
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
}

interface ChatRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

interface UpstreamRequest {
  readonly method: string
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

interface UpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: ReadableStream<Uint8Array>
}

type UpstreamSender = (request: UpstreamRequest) => Promise<UpstreamResponse>

interface ChatResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface ChatService {
  handleChatCompletions(request: ChatRequest, send: UpstreamSender): Promise<ChatResponse>
}

type AdapterFactory = (options: ServiceOptions) => ChatService

interface AdapterLoadResult {
  readonly factory?: AdapterFactory
  readonly skipReason?: string
}

async function loadAdapter(): Promise<AdapterLoadResult> {
  try {
    const imported = (await import(ADAPTER_MODULE)) as Record<string, unknown>
    const candidate = imported[ADAPTER_EXPORT]
    if (typeof candidate === 'function') {
      return { factory: candidate as AdapterFactory }
    }
    return {
      skipReason: `\`${ADAPTER_MODULE}\` does not export \`${ADAPTER_EXPORT}(options)\` yet. ` +
        'All 26 S2d3 golden cases SKIP until the oai2cla adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d3 — oai2cla golden contract (recorded fixtures)'
  : `S2d3 — oai2cla golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d3/', import.meta.url)
const GATEWAY_VERSION = 'v7.3.4'
const FROZEN_NOW_MS = 1_789_495_019_000

/** Recording-instance credential sets, transcribed from the meta.yaml config fragments. */
const DEFAULT_CREDENTIALS: readonly CredentialConfig[] = [
  {
    apiKey: 'mock-claude-key',
    baseUrl: 'http://host.docker.internal:20002',
    models: [{ name: 'claude-mock-model', alias: 'cm' }],
  },
]

const FOLLOWUP_CREDENTIALS: readonly CredentialConfig[] = [
  {
    apiKey: 'mock-claude-key',
    baseUrl: 'http://host.docker.internal:20002',
    models: [
      { name: 'claude-mock-model', alias: 'cm' },
      { name: 'claude-mock-model', alias: 'cmc', isCompat: true },
      { name: 'claude-mock-model', alias: 'cmt-budget', thinking: { min: 1024, max: 32000 } },
      { name: 'claude-mock-model', alias: 'cmt-levels', thinking: { levels: ['low', 'medium', 'high', 'max'] } },
    ],
  },
  {
    apiKey: 'mock-claude-key',
    baseUrl: 'http://host.docker.internal:20002',
    fingerprintProfile: 'claude-code-cli',
    models: [{ name: 'claude-mock-model', alias: 'cmfp' }],
  },
]

const EXPECTED_CASES = [
  's2d3-baseline-nonstream',
  's2d3-baseline-stream',
  's2d3-developer-respformat',
  's2d3-disconnect',
  's2d3-effort-thinking',
  's2d3-empty-stream',
  's2d3-err-429-verbatim-cooldown',
  's2d3-err-instream-event',
  's2d3-err-wrap-500-nonjson',
  's2d3-fingerprint-cli-profile',
  's2d3-headers-variants',
  's2d3-iscompat-thinking-history',
  's2d3-malformed-validation',
  's2d3-model-suffix',
  's2d3-multimodal-image',
  's2d3-params-system',
  's2d3-res-stopreasons-usage',
  's2d3-res-thinking',
  's2d3-res-tooluse-nonstream',
  's2d3-res-tooluse-stream',
  's2d3-retry-after',
  's2d3-slow',
  's2d3-stream-429-commit',
  's2d3-thinking-config-survival',
  's2d3-tools-roundtrip',
  's2d3-userid-variants',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  // Fixture recorders wrote raw wire line terminators (CRLF request heads, chunked-framing
  // sections). Every compared surface (request bodies, SSE frame blocks, header sections)
  // is CR-free — verified across all 26 cases — so terminators are normalized on read and
  // never enter a byte comparison.
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  return raw.replaceAll('\r\n', '\n')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

// ─── Fixture file parsers (request.http / downstream.md) ─────────────────────────────

function parseRequestHttp(text: string): ChatRequest {
  const head = text.split('\n\n', 1)[0] ?? ''
  const rest = text.slice(head.length + 2)
  const lines = head.split('\n')
  const requestLine = lines[0] ?? ''
  const parts = requestLine.split(' ')
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }
  // Fixture files end with a single trailing newline that was not part of the sent body.
  const body = rest.endsWith('\n') ? rest.slice(0, -1) : rest
  return { method: parts[0] ?? '', path: parts[1] ?? '', headers, body }
}

interface RecordedResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
}

function parseDownstreamMarkdown(text: string): RecordedResponse {
  const lines = text.split('\n')
  const headers: Array<[string, string]> = []
  let status = 0
  let body: string | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (status === 0 && line.startsWith('HTTP/1.1 ')) {
      status = Number(line.split(' ')[1])
      index += 1
      continue
    }
    if (line.startsWith('## Response headers')) {
      index += 1
      while (index < lines.length && (lines[index] ?? '').trim() !== '') {
        const entry = lines[index] ?? ''
        const separator = entry.indexOf(': ')
        if (separator > 0) headers.push([entry.slice(0, separator), entry.slice(separator + 2)])
        index += 1
      }
      continue
    }
    if (body === undefined && line.startsWith('## Body')) {
      // Only the first "## Body" section counts; later sections repeat the raw chunk framing.
      let cursor = index
      while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) cursor += 1
      const start = cursor + 1
      let end = start
      while (end < lines.length && !(lines[end] ?? '').startsWith('```')) end += 1
      body = lines.slice(start, end).join('\n')
      index = end
    }
    index += 1
  }
  if (status === 0 || body === undefined) {
    throw new Error('downstream.md is missing a status line or a body section')
  }
  return { status, headers, body }
}

// ─── Masking (meta.yaml dynamic_fields → normalization) ──────────────────────────────

interface MaskProfile {
  readonly created: boolean
  readonly date: boolean
  readonly trace: boolean
  readonly port: boolean
  readonly uuid: boolean
  readonly cooldownTiming: boolean
}

const CREATED_RE = /"created":\d+/g
const DATE_CONTEXT_RE = /Today's date is \d{4}-\d{2}-\d{2}\./g
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const DEVICE_ID_RE = /(device_id\\{0,2}"\s*:\s*\\{0,2}")[0-9a-f]{64}/g
const RESET_SECONDS_RE = /"reset_seconds":\d+/g
const RESET_TIME_RE = /"reset_time":"\d+s"/g
const PORT_SUFFIX_RE = /:\d+$/

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  const profile = { created: false, date: false, trace: false, port: false, uuid: false, cooldownTiming: false }
  for (const field of dynamicFields) {
    if (field === 'Date') { profile.date = true; continue }
    if (field === 'X-Cpa-Trace-Id') { profile.trace = true; continue }
    if (field === 'downstream created' || field === 'created in chunks' || field === 'created' || field === 'created in chunk') {
      profile.created = true
      continue
    }
    if (field === 'mock port' || field === 'mock port in upstream.jsonl') { profile.port = true; continue }
    // Case 14's scripted 429 carries no upstream reset header: spec §5.4 pins the literal
    // `Retry-After: 1` / `"reset_seconds":1` / `"reset_time":"1s"` — deliberately NOT masked.
    if (field === 'cooldown reset/timing text inside model_cooldown envelope if present') continue
    if (field === 'Retry-After value if fuzz-derived' || field === 'reset_time/reset_seconds in cooldown envelope') {
      profile.cooldownTiming = true
      continue
    }
    if (field === 'X-Claude-Code-Session-Id (UUID)' || field === 'any UUID fields in metadata/billing tags') {
      profile.uuid = true
      continue
    }
    if (field.startsWith('metadata.user_id')) continue // deterministic sha256 — byte-pinned, not masked
    throw new Error(
      `S2d3[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s2d3-oai2cla.test.ts consciously',
    )
  }
  return profile
}

function normalizeBodyText(text: string, mask: MaskProfile): string {
  let out = text
  if (mask.created) out = out.replace(CREATED_RE, '"created":<EPOCH>')
  if (mask.date) out = out.replace(DATE_CONTEXT_RE, "Today's date is <DATE>.")
  if (mask.uuid) {
    out = out.replace(UUID_RE, '<UUID>')
    out = out.replace(DEVICE_ID_RE, '$1<UUID>')
  }
  if (mask.cooldownTiming) {
    out = out.replace(RESET_SECONDS_RE, '"reset_seconds":<RESET_SECONDS>')
    out = out.replace(RESET_TIME_RE, '"reset_time":"<RESET_SECONDS>s"')
  }
  return out
}

function normalizeHeaderValue(name: string, value: string, mask: MaskProfile): string {
  const key = name.toLowerCase()
  if (key === 'host' && mask.port) return value.replace(PORT_SUFFIX_RE, ':<PORT>')
  if (key === 'retry-after' && mask.cooldownTiming) return '<FUZZ>'
  if (key === 'x-claude-code-session-id' && mask.uuid) return '<UUID>'
  return value
}

// ─── Canned mock scripts (spec/recordings/S2d3.cases.json scripts_needed + follow-up) ─

interface MockEvent {
  readonly event: string
  readonly data: unknown
}

type MockScript =
  | { readonly kind: 'events'; readonly events: readonly MockEvent[] }
  | { readonly kind: 'raw'; readonly text: string }

function messageStart(id: string, usage: Record<string, number>): MockEvent {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model: '$MODEL', content: [], stop_reason: null, stop_sequence: null, usage },
    },
  }
}

const TEXT_BLOCK_START: MockEvent = { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }
const TEXT_BLOCK_STOP: MockEvent = { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
const MESSAGE_STOP: MockEvent = { event: 'message_stop', data: { type: 'message_stop' } }

const SCRIPTS: Readonly<Record<string, MockScript>> = {
  happy: {
    kind: 'events',
    events: [
      messageStart('msg_mock_01', { input_tokens: 9, output_tokens: 1 }),
      TEXT_BLOCK_START,
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from mock claude upstream' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' more' } } },
      TEXT_BLOCK_STOP,
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } } },
      MESSAGE_STOP,
    ],
  },
  tool_use: {
    kind: 'events',
    events: [
      messageStart('msg_tool_01', { input_tokens: 9, output_tokens: 1 }),
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock01', name: 'get_weather', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } } },
      MESSAGE_STOP,
    ],
  },
  thinking: {
    kind: 'events',
    events: [
      messageStart('msg_think_01', { input_tokens: 9, output_tokens: 1 }),
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-mock-01' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer.' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } } },
      MESSAGE_STOP,
    ],
  },
  stop_variant: {
    kind: 'events',
    events: [
      messageStart('msg_stop_01', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 32, cache_creation_input_tokens: 5 }),
      TEXT_BLOCK_START,
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } },
      TEXT_BLOCK_STOP,
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: '$STOP_REASON', stop_sequence: 'END' }, usage: { output_tokens: 7 } } },
      MESSAGE_STOP,
    ],
  },
  error_event: {
    kind: 'events',
    events: [
      messageStart('msg_err_01', { input_tokens: 9, output_tokens: 1 }),
      { event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'mock in-stream error' } } },
    ],
  },
  empty: { kind: 'events', events: [] },
  ping_only: { kind: 'events', events: [{ event: 'ping', data: { type: 'ping' } }] },
  bad_json: { kind: 'raw', text: 'data: {"type": "message_start", not-json\n\n' },
  no_start: {
    kind: 'events',
    events: [
      TEXT_BLOCK_START,
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      MESSAGE_STOP,
    ],
  },
  start_no_id: {
    kind: 'events',
    events: [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { type: 'message', role: 'assistant', model: '$MODEL', content: [], usage: { input_tokens: 9 } },
        },
      },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      MESSAGE_STOP,
    ],
  },
  no_delta: {
    kind: 'events',
    events: [
      messageStart('msg_val_01', { input_tokens: 9, output_tokens: 1 }),
      TEXT_BLOCK_START,
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } },
      TEXT_BLOCK_STOP,
      MESSAGE_STOP,
    ],
  },
}

// ─── Mock upstream transport ──────────────────────────────────────────────────────────

interface MockControl {
  readonly mode?: string
  readonly script?: string
  readonly status?: number
  readonly error_body?: unknown
  readonly raw_body?: string
  readonly retry_after?: string | number
  readonly after?: number
  readonly delay_ms?: number
  readonly stop_reason?: string
}

interface MockResponseSpec {
  readonly status: number
  readonly headers: HeaderList
  readonly body: ReadableStream<Uint8Array>
}

const encoder = new TextEncoder()

/** Serializes like Python's json.dumps defaults — the recorded verbatim 429 passthrough bytes depend on it. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

function substitute(value: unknown, replacements: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const [token, replacement] of Object.entries(replacements)) out = out.split(token).join(replacement)
    return out
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, replacements))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry, replacements)
    return out
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Demand-driven byte stream: every pull hands out one chunk; the read after the last chunk errors (disconnect) or closes. */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number; readonly delayMs?: number } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (options.delayMs !== undefined && index > 0) await sleep(options.delayMs)
      if (options.abortAfter !== undefined && index >= options.abortAfter) {
        controller.error(new Error('mock upstream: connection reset mid-stream'))
        return
      }
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
  })
}

function buildMockResponse(control: MockControl | undefined, upstreamRequest: UpstreamRequest): MockResponseSpec {
  if (control === undefined) throw new Error('harness bug: no mock control for the current step')
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    const status = control.status ?? 500
    const bodyText =
      control.raw_body !== undefined ? control.raw_body : pythonJson(control.error_body ?? {})
    const headers: Array<[string, string]> = [['Content-Type', 'application/json']]
    if (control.retry_after !== undefined) headers.push(['Retry-After', String(control.retry_after)])
    return { status, headers, body: scriptedByteStream([encoder.encode(bodyText)]) }
  }
  const scriptName = control.script ?? 'happy'
  const script = SCRIPTS[scriptName]
  if (script === undefined) {
    throw new Error(`harness has no canned mock script ${JSON.stringify(scriptName)} — add it before replaying this fixture`)
  }
  let parsedModel: string
  try {
    parsedModel = String((JSON.parse(upstreamRequest.body) as { model?: unknown }).model ?? '')
  } catch {
    throw new Error('mock upstream could not read the model from the translated upstream body')
  }
  const replacements: Record<string, string> = { $MODEL: parsedModel }
  if (control.stop_reason !== undefined) replacements.$STOP_REASON = control.stop_reason
  let chunks: Uint8Array[]
  if (script.kind === 'raw') {
    chunks = [encoder.encode(script.text)]
  } else {
    chunks = script.events.map((mockEvent) => {
      const data = pythonJson(substitute(mockEvent.data, replacements))
      return encoder.encode(`event: ${mockEvent.event}\ndata: ${data}\n\n`)
    })
  }
  const abortAfter = mode === 'disconnect' ? (control.after ?? chunks.length) : undefined
  const delayMs = mode === 'slow' ? (control.delay_ms ?? 0) : undefined
  return { status: 200, headers: [['Content-Type', 'text/event-stream']], body: scriptedByteStream(chunks, { abortAfter, delayMs }) }
}

// ─── Comparison helpers ──────────────────────────────────────────────────────────────

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: ChatResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  if (body !== null && typeof body === 'object' && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
    return out + decoder.decode()
  }
  throw new Error('adapter response body must be a string or a web ReadableStream (see adapter interface in the header)')
}

function decodeSseDataFrames(body: string): string[] {
  const frames: string[] = []
  for (const block of body.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) frames.push(line.slice('data: '.length))
    }
  }
  return frames
}

function isToolCallsDeltaFrame(frame: string): boolean {
  return frame.includes('"delta":{"tool_calls"')
}

/** R-ORDER: adjacent tool_calls delta frames compare as a sorted multiset; everything else is order-pinned. */
function expectFrameSequence(actual: readonly string[], expected: readonly string[], context: string): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `${context}: decoded SSE frame count ${actual.length} != recorded ${expected.length}. ` +
        `First difference: ${firstDifference(actual, expected)}`,
    )
  }
  let index = 0
  while (index < expected.length) {
    const expectedIsTool = isToolCallsDeltaFrame(expected[index] ?? '')
    const actualIsTool = isToolCallsDeltaFrame(actual[index] ?? '')
    if (expectedIsTool !== actualIsTool) {
      throw new Error(`${context}: frame ${index} kind mismatch (tool_calls delta or not) — recorded ${expected[index]} vs produced ${actual[index]}`)
    }
    if (expectedIsTool) {
      let expectedEnd = index
      while (expectedEnd < expected.length && isToolCallsDeltaFrame(expected[expectedEnd] ?? '')) expectedEnd += 1
      let actualEnd = index
      while (actualEnd < actual.length && isToolCallsDeltaFrame(actual[actualEnd] ?? '')) actualEnd += 1
      if (expectedEnd !== actualEnd) {
        throw new Error(`${context}: adjacent tool_calls frame run length mismatch (${actualEnd - index} vs ${expectedEnd - index})`)
      }
      expect([...actual.slice(index, actualEnd)].sort(), `${context}: tool_calls frame multiset`).toEqual(
        [...expected.slice(index, expectedEnd)].sort(),
      )
      index = expectedEnd
    } else {
      expect(actual[index], `${context}: SSE frame ${index}`).toBe(expected[index])
      index += 1
    }
  }
}

function firstDifference(actual: readonly string[], expected: readonly string[]): string {
  const count = Math.min(actual.length, expected.length)
  for (let i = 0; i < count; i += 1) {
    if (actual[i] !== expected[i]) {
      return `frame ${i}: recorded ${truncate(expected[i] ?? '')} vs produced ${truncate(actual[i] ?? '')}`
    }
  }
  return count === 0 ? 'one side is empty' : 'common prefix matches; one side has extra trailing frames'
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

interface CapturedUpstreamCall {
  readonly step: number
  readonly call: UpstreamRequest
}

function assertUpstreamWire(
  recorded: RecordedUpstreamLine,
  captured: CapturedUpstreamCall,
  mask: MaskProfile,
  baseUrl: string,
): void {
  const context = `S2d3[${captured.call.url}] step ${captured.step} upstream wire`
  expect(captured.call.method, `${context}: method`).toBe(recorded.method)
  expect(captured.call.url, `${context}: url (baseUrl + recorded path)`).toBe(`${baseUrl.replace(/\/$/, '')}${recorded.path}`)

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue // transport-derived; checked for consistency below
    expectedPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  const actualPairs: Array<[string, string]> = []
  let actualContentLength: string | undefined
  for (const [name, value] of captured.call.headers) {
    if (name.toLowerCase() === 'content-length') {
      actualContentLength = value
      continue
    }
    if (name.toLowerCase() === 'authorization') {
      expect(value.startsWith('Bearer '), `${context}: Authorization must carry the Bearer scheme`).toBe(true)
      actualPairs.push([name, '<redacted>'])
      continue
    }
    actualPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length must match the body byte length`).toBe(
      String(encoder.encode(captured.call.body).length),
    )
  }
  expect(normalizeBodyText(captured.call.body, mask), `${context}: translated body bytes`).toBe(
    normalizeBodyText(recorded.body, mask),
  )
}

async function assertDownstreamStep(
  response: ChatResponse,
  expected: RecordedResponse,
  mask: MaskProfile,
  caseId: string,
  step: number,
): Promise<void> {
  const context = `S2d3[${caseId}] step ${step} downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  expect(expectedContentType, `${context}: fixture must record Content-Type`).toBeDefined()
  expect(headerValue(response.headers, 'content-type'), `${context}: Content-Type`).toBe(expectedContentType)

  const expectedCacheControl = headerValue(expected.headers, 'cache-control')
  const actualCacheControl = headerValue(response.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(actualCacheControl, `${context}: Cache-Control must be absent outside SSE commits`).toBeUndefined()
  } else {
    expect(actualCacheControl, `${context}: Cache-Control`).toBe(expectedCacheControl)
  }

  const expectedRetryAfter = headerValue(expected.headers, 'retry-after')
  const actualRetryAfter = headerValue(response.headers, 'retry-after')
  if (expectedRetryAfter === undefined) {
    expect(actualRetryAfter, `${context}: Retry-After must be absent when the recording has none`).toBeUndefined()
  } else {
    expect(
      actualRetryAfter !== undefined ? normalizeHeaderValue('retry-after', actualRetryAfter, mask) : undefined,
      `${context}: Retry-After`,
    ).toBe(normalizeHeaderValue('retry-after', expectedRetryAfter, mask))
  }

  if (expectedContentType === 'text/event-stream') {
    for (const line of body.split('\n')) {
      expect(
        line.startsWith('event:'),
        `${context}: downstream SSE must contain only data: frames (S2d3 §4.6) — found ${truncate(line)}`,
      ).toBe(false)
    }
    const expectedFrames = decodeSseDataFrames(expected.body).map((frame) => normalizeBodyText(frame, mask))
    const actualFrames = decodeSseDataFrames(body).map((frame) => normalizeBodyText(frame, mask))
    expectFrameSequence(actualFrames, expectedFrames, context)
  } else {
    expect(normalizeBodyText(body, mask), `${context}: body bytes`).toBe(normalizeBodyText(expected.body, mask))
  }
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

interface CaseMeta {
  readonly case: string
  readonly instance: string
  readonly requests: ReadonlyArray<{ readonly file: string; readonly step: number }>
  readonly responses: ReadonlyArray<{ readonly file: string; readonly step: number; readonly status: number }>
  readonly dynamic_fields: readonly string[]
}

interface MockResponseFile {
  readonly control_file_per_step: readonly MockControl[]
}

async function replayCase(caseId: CaseId): Promise<void> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const mockFile = await readFixtureJson<MockResponseFile>(caseId, 'mock-response.json')
  const controls = mockFile.control_file_per_step
  const recordedUpstreamText = await readFixtureText(caseId, 'upstream.jsonl')
  const recordedUpstream = recordedUpstreamText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
  const mask = maskProfile(caseId, meta.dynamic_fields)
  const credentials = meta.instance === 'S2d3-followup' ? FOLLOWUP_CREDENTIALS : DEFAULT_CREDENTIALS
  const baseUrl = credentials[0]?.baseUrl ?? ''

  const service = adapterFactory({
    credentials,
    gatewayVersion: GATEWAY_VERSION,
    store: new MemoryStore({ now: () => FROZEN_NOW_MS }),
    now: () => FROZEN_NOW_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  if (typeof service.handleChatCompletions !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleChatCompletions(request, send) method`)
  }

  const captured: CapturedUpstreamCall[] = []
  let currentStep = 0
  const send: UpstreamSender = async (call) => {
    captured.push({ step: currentStep, call })
    const control = controls[currentStep - 1]
    return buildMockResponse(control, call)
  }

  const steps = [...meta.requests].sort((left, right) => left.step - right.step)
  expect(controls.length, `S2d3[${caseId}]: one mock control per step`).toBe(steps.length)
  for (const stepEntry of steps) {
    currentStep = stepEntry.step
    const request = parseRequestHttp(await readFixtureText(caseId, stepEntry.file))
    const responseFile = meta.responses.find((entry) => entry.step === stepEntry.step)
    expect(responseFile, `S2d3[${caseId}] step ${currentStep}: fixture must record a downstream response`).toBeDefined()
    const expected = parseDownstreamMarkdown(await readFixtureText(caseId, responseFile?.file ?? ''))
    const response = await service.handleChatCompletions(request, send)
    await assertDownstreamStep(response, expected, mask, caseId, currentStep)
  }

  expect(captured.length, `S2d3[${caseId}]: upstream call count (cooldown steps must not call upstream)`).toBe(recordedUpstream.length)
  for (let index = 0; index < recordedUpstream.length; index += 1) {
    const recorded = recordedUpstream[index]
    const capturedCall = captured[index]
    expect(capturedCall, `S2d3[${caseId}]: missing upstream call ${index + 1}`).toBeDefined()
    if (recorded !== undefined && capturedCall !== undefined) {
      assertUpstreamWire(recorded, capturedCall, mask, baseUrl)
    }
  }
}

// ─── Suites ──────────────────────────────────────────────────────────────────────────

describe('S2d3 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 26 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      const mockFile = await readFixtureJson<MockResponseFile>(caseId, 'mock-response.json')
      expect(meta.case, `${caseId}: meta.case echoes the directory name`).toBe(caseId)
      expect(mockFile.control_file_per_step.length, `${caseId}: one control per recorded step`).toBe(meta.requests.length)
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields
      const upstreamText = await readFixtureText(caseId, 'upstream.jsonl')
      for (const line of upstreamText.split('\n').filter((entry) => entry.trim() !== '')) {
        expect(() => JSON.parse(line), `${caseId}: upstream.jsonl lines parse`).not.toThrow()
      }
      for (const requestEntry of meta.requests) {
        const request = parseRequestHttp(await readFixtureText(caseId, requestEntry.file))
        const contentLength = Number(headerValue(request.headers, 'content-length'))
        expect(contentLength, `${caseId} ${requestEntry.file}: parsed body length matches the recorded Content-Length`).toBe(
          new TextEncoder().encode(request.body).length,
        )
        expect(request.method, `${caseId} ${requestEntry.file}: route method`).toBe('POST')
        expect(request.path, `${caseId} ${requestEntry.file}: route path`).toBe('/v1/chat/completions')
      }
      for (const responseEntry of meta.responses) {
        const recorded = parseDownstreamMarkdown(await readFixtureText(caseId, responseEntry.file))
        expect(recorded.status, `${caseId} ${responseEntry.file}: meta status agrees with the recorded status line`).toBe(responseEntry.status)
      }
    }
  })
})

suite(suiteTitle, () => {
  for (const caseId of EXPECTED_CASES) {
    it(`${caseId} — replays recorded steps: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      await replayCase(caseId)
    })
  }
})

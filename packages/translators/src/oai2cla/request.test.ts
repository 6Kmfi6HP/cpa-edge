/**
 * Golden replay: every recorded S2d3 case, request direction.
 *
 * Each recorded client request is translated with the case's serving
 * configuration and asserted BYTE-EXACT against the recorded upstream body
 * (the dynamic identity values of the fingerprint case are pinned through
 * the context, so no masking is needed). The recorded upstream header maps
 * are asserted through the header builder for the caller-owned surface.
 */
import { describe, expect, it } from 'vitest'
import { buildClaudeUpstreamHeaders } from './headers'
import { translateChatToClaude } from './request'
import type { ChatToClaudeContext, ClaudeCodeCliIdentity } from './types'
import { countRecordedSteps, readRecordedRequest, readRecordedUpstreams } from './fixture-reader'

const UPSTREAM_MODEL = 'claude-mock-model'
const UPSTREAM_BASE = 'http://host.docker.internal:20002'
const UPSTREAM_KEY = 'mock-claude-key'
const GATEWAY_VERSION = 'v7.3.4'

const CLI_IDENTITY: ClaudeCodeCliIdentity = Object.freeze({
  sessionId: 'ccc8fc69-9d76-5197-8ea2-6aa3a95bf375',
  accountUuid: 'b65db0b7-7ca5-5d56-8691-63765229ed97',
  deviceId: '49569a30512583bc5bbd5b91e765a20ab21ceab098408c09ee0964ce577a9fef',
  date: '2026-09-16',
})

/** Serving configuration per client model alias (follow-up config fragment). */
function contextForModel(clientModel: string): ChatToClaudeContext {
  if (clientModel === 'cmc') return { upstreamModel: UPSTREAM_MODEL, compat: true }
  if (clientModel === 'cmt-budget') {
    return { upstreamModel: UPSTREAM_MODEL, thinking: { kind: 'budget', min: 1024, max: 32000 } }
  }
  if (clientModel === 'cmt-levels') {
    return { upstreamModel: UPSTREAM_MODEL, thinking: { kind: 'levels', levels: ['low', 'medium', 'high', 'max'] } }
  }
  if (clientModel === 'cmfp') {
    return { upstreamModel: UPSTREAM_MODEL, fingerprintProfile: 'claude-code-cli', cliIdentity: CLI_IDENTITY }
  }
  return { upstreamModel: UPSTREAM_MODEL }
}

const TRANSPORT_HEADERS = new Set(['host', 'content-length'])

/** Upstream headers the gateway itself sets (checked separately). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key'])

describe('S2d3 golden replay — request translation', () => {
  const cases = [
    's2d3-baseline-nonstream',
    's2d3-baseline-stream',
    's2d3-headers-variants',
    's2d3-params-system',
    's2d3-multimodal-image',
    's2d3-tools-roundtrip',
    's2d3-developer-respformat',
    's2d3-effort-thinking',
    's2d3-userid-variants',
    's2d3-res-tooluse-stream',
    's2d3-respformat-json-object',
    's2d3-res-tooluse-nonstream',
    's2d3-res-thinking',
    's2d3-res-stopreasons-usage',
    's2d3-err-429-verbatim-cooldown',
    's2d3-err-wrap-500-nonjson',
    's2d3-err-instream-event',
    's2d3-disconnect',
    's2d3-slow',
    's2d3-iscompat-thinking-history',
    's2d3-thinking-config-survival',
    's2d3-fingerprint-cli-profile',
    's2d3-model-suffix',
    's2d3-stream-429-commit',
    's2d3-empty-stream',
    's2d3-malformed-validation',
    's2d3-retry-after',
  ]

  for (const caseId of cases) {
    it(`${caseId}: upstream body is byte-exact`, async () => {
      const steps = countRecordedSteps(caseId)
      const upstreams = readRecordedUpstreams(caseId)
      expect(upstreams.length).toBe(steps)
      for (let step = 1; step <= steps; step++) {
        const request = readRecordedRequest(caseId, step)
        const upstream = upstreams[step - 1]
        expect(upstream).toBeDefined()
        if (upstream === undefined) continue
        expect(upstream.method).toBe('POST')
        expect(upstream.path).toBe('/v1/messages?beta=true')

        const clientModel = extractModel(request.body)
        const translated = await translateChatToClaude(request.body, contextForModel(clientModel))
        expect(translated.body).toBe(upstream.body)
      }
    })
  }

  for (const caseId of cases) {
    it(`${caseId}: upstream headers match the recorded set`, async () => {
      const steps = countRecordedSteps(caseId)
      const upstreams = readRecordedUpstreams(caseId)
      for (let step = 1; step <= steps; step++) {
        const request = readRecordedRequest(caseId, step)
        const upstream = upstreams[step - 1]
        if (upstream === undefined) continue
        const clientModel = extractModel(request.body)
        const ctx = contextForModel(clientModel)
        const translated = await translateChatToClaude(request.body, ctx)
        const headers = buildClaudeUpstreamHeaders({
          clientHeaders: dropTransportHeaders(request.headers),
          apiKey: UPSTREAM_KEY,
          baseUrl: UPSTREAM_BASE,
          gatewayVersion: GATEWAY_VERSION,
          fingerprintProfile: ctx.fingerprintProfile,
          cliIdentity: ctx.cliIdentity,
          body: translated.value,
        })
        const expected = lowercaseMap(dropKeys(upstream.headers, TRANSPORT_HEADERS))
        const produced = lowercaseMap(headers)
        for (const name of Object.keys(expected)) {
          const value = expected[name] ?? ''
          if (CREDENTIAL_HEADERS.has(name)) {
            expect(produced[name]).toBeDefined()
            expect(produced[name]).toMatch(/^(Bearer |mock-claude-key)/)
            continue
          }
          expect(produced[name], `${caseId} step ${step} header ${name}`).toBe(value)
        }
        for (const name of Object.keys(produced)) {
          expect(expected[name], `${caseId} step ${step} unexpected header ${name}`).toBeDefined()
        }
      }
    })
  }

  it('X-Mock-* and non-forwarded client headers never reach the upstream', async () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: {
        'X-Mock-Mode': 'happy',
        'Content-Type': 'application/json',
        Authorization: 'Bearer client-key',
        Connection: 'close',
        'X-Not-Forwarded': 'nope',
        'X-Stainless-Retry-Count': '3',
        'Anthropic-Custom-Thing': 'yes',
      },
      apiKey: UPSTREAM_KEY,
      baseUrl: UPSTREAM_BASE,
    })
    expect(headers['X-Mock-Mode']).toBeUndefined()
    expect(headers['X-Not-Forwarded']).toBeUndefined()
    expect(headers['Connection']).toBeUndefined()
    expect(headers['X-Stainless-Retry-Count']).toBe('3')
    expect(headers['Anthropic-Custom-Thing']).toBe('yes')
    expect(headers['Authorization']).toBe(`Bearer ${UPSTREAM_KEY}`)
  })
})

function extractModel(body: string): string {
  const parsed = JSON.parse(body) as { model?: unknown }
  return typeof parsed.model === 'string' ? parsed.model : ''
}

function dropTransportHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(headers)) {
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'authorization') continue // client auth, never forwarded
    out[name] = headers[name] ?? ''
  }
  return out
}

function lowercaseMap(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(headers)) {
    out[name.toLowerCase()] = headers[name] ?? ''
  }
  return out
}

function dropKeys(
  headers: Readonly<Record<string, string>>,
  drop: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(headers)) {
    if (drop.has(name.toLowerCase())) continue
    out[name] = headers[name] ?? ''
  }
  return out
}

/**
 * Unit coverage for rules the recorded goldens do not exercise alone:
 * the byte-encoding ladder (HTML escaping vs. raw client bytes), the
 * generated key orders, the thought-signature sentinel policy, the schema
 * enum-hint surgery, tool identifier sanitization and the response-side
 * name restore, the tool_result name-resolution and result-encoding
 * ladders, merge/reorder/align edges, the trailing-model strip and the
 * executor boundary turns, the two-stage thinking rule, the countTokens
 * body variant, the error type/message ladders, the stream state-machine
 * edges (usageMetadata filter, final-events gate, empty-name deltas,
 * disconnect terminal), the o200k estimate, and the service facade gates
 * (gateway key, alias rejection, the recorded malformed-body envelope,
 * the 429 cooldown slice).
 */
import { describe, expect, it } from 'vitest'
import { CpaError, MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'
import { serializeOrdered } from './json'
import {
  buildFunctionDeclarations,
  buildToolNameIndex,
  cleanGeminiSchema,
  restoreToolName,
  sanitizeClaudeToolId,
  sanitizeFunctionName,
} from './schema'
import {
  buildGenerationConfig,
  buildSystemInstruction,
  buildToolConfig,
  translateClaudeToGemini,
} from './request'
import { claudeRequestSegments, estimateClaudeInputTokens } from './tokens'
import {
  claudeStopReason,
  claudeUsageObject,
  formatClaudeEvent,
  formatTerminalErrorEvent,
  GeminiToClaudeStreamTranslator,
  readGeminiUsage,
  translateGeminiResponseToClaude,
} from './response'
import type { GeminiToClaudeContext } from './response'
import {
  buildClaudeErrorEnvelope,
  buildModelCooldownResponse,
  claudeErrorTypeForStatus,
  extractClaudeError,
} from './errors'
import { bootstrapCla2GemStream } from './stream'
import { decodeUpstreamDataLines, frameDownstream } from './sse'
import { buildGeminiUpstreamHeaders } from './headers'
import { createCla2GemService } from './service'
import type {
  Cla2GemRequest,
  Cla2GemResponse,
  Cla2GemUpstreamRequest,
  Cla2GemUpstreamResponse,
  Cla2GemUpstreamSender,
} from './service'

const UPSTREAM_MODEL = 'gemini-mock-model'
const BASE = 'http://mock.internal:19001'
const encoder = new TextEncoder()

function ctx(thinking?: import('./types').Cla2GemThinkingCapability) {
  return { upstreamModel: UPSTREAM_MODEL, thinking: thinking }
}

function translate(body: unknown, thinking?: import('./types').Cla2GemThinkingCapability): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return translateClaudeToGemini(text, ctx(thinking)).body
}

function translateValue(text: string, thinking?: import('./types').Cla2GemThinkingCapability) {
  return JSON.parse(translateClaudeToGemini(text, ctx(thinking)).body) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Byte encoding (section 3.2 rules 13-16)
// ---------------------------------------------------------------------------

describe('byte encoding', () => {
  it('HTML-escapes gateway-written strings but never raw client values', () => {
    const body =
      '{"model":"gm","system":"a<b>&c","messages":[{"role":"user","content":[{"type":"text","text":"x<y&z"}]}],' +
      '"tools":[{"name":"t","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}],' +
      '"tool_choice":{"type":"tool","name":"a<b"},"thinking":{"type":"enabled","budget_tokens":8},' +
      '"max_tokens":5}'
    const upstreamUserDefined = translate(body, { kind: 'budget', min: 0, max: 64 })
    expect(upstreamUserDefined).toContain('"text":"a\\u003cb\\u003e\\u0026c"')
    expect(upstreamUserDefined).toContain('"text":"x\\u003cy\\u0026z"')
    // Gateway-written identifiers are sanitized, so no raw < can appear in
    // them; raw values (the schema) keep their client bytes.
    expect(upstreamUserDefined).toContain('"type":"object"')
  })

  it('functionCall key order is name,args,id with the sentinel only on the first call of a turn', () => {
    const body = {
      model: 'gm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: { x: 1 } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'g', input: { y: 2 } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'h', input: {} }, { type: 'tool_use', id: 'd', name: 'i', input: {} }] },
        { role: 'user', content: 'go on' },
      ],
    }
    const value = JSON.parse(translate(body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }
    // contents[0] is the leading boundary user turn (model-first request).
    const turn1 = value.contents[1]?.parts[0]
    const turn2 = value.contents[2]?.parts[0]
    const turn3 = value.contents[3]?.parts
    expect(Object.keys(turn1 ?? {})).toEqual(['thoughtSignature', 'functionCall'])
    expect(Object.keys((turn1?.['functionCall'] as Record<string, unknown>) ?? {})).toEqual(['name', 'args', 'id'])
    // A fresh model turn gets its own sentinel ...
    expect(Object.keys(turn2 ?? {})).toEqual(['thoughtSignature', 'functionCall'])
    // ... but sibling calls in the SAME turn do not.
    expect(Object.keys(turn3?.[0] ?? {})).toEqual(['thoughtSignature', 'functionCall'])
    expect(Object.keys(turn3?.[1] ?? {})).toEqual(['functionCall'])
  })

  it('raw client bytes survive for tool args, tool_result payloads and schemas', () => {
    const raw =
      '{"model":"gm","tools":[{"name":"t","input_schema":{"type":"object",   "properties":{"q":{"type":"string"}}}}],' +
      '"messages":[{"role":"user","content":[{"type":"text","text":"go"}]},' +
      '{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"t","input":{"a":  1}}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":[{"type":"text","text":"ok"}]}]}]}'
    const text = translate(raw)
    expect(text).toContain('"parametersJsonSchema":{"type":"object",   "properties":{"q":{"type":"string"}}}')
    expect(text).toContain('"args":{"a":  1}')
    expect(text).toContain('"result":{"type":"text","text":"ok"}')
  })

  it('functionResponse key order is name,response,id and images hug their own response', () => {
    const body = {
      model: 'gm',
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'f', input: {} }, { type: 'tool_use', id: 'y', name: 'f', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'after' },
            { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'X' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
            { type: 'tool_result', tool_use_id: 'y', content: 'Y' },
          ],
        },
      ],
    }
    const value = JSON.parse(translate(body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }
    const userParts = value.contents[2]?.parts ?? []
    expect(userParts.map((part) => Object.keys(part)[0])).toEqual([
      'text',
      'functionResponse',
      'inline_data',
      'functionResponse',
    ])
    const response = userParts[1]?.['functionResponse'] as Record<string, unknown>
    expect(Object.keys(response)).toEqual(['name', 'response', 'id'])
    const other = userParts[3]?.['functionResponse'] as Record<string, unknown>
    expect(other['id']).toBe('y')
  })
})

// ---------------------------------------------------------------------------
// Schema cleaning and identifiers
// ---------------------------------------------------------------------------

describe('schema cleaning and identifiers', () => {
  it('enum hint: compact enum + appended description, client bytes elsewhere', () => {
    const cleaned = cleanGeminiSchema('{"type": "string", "enum": ["a", "b"]}')
    expect(cleaned).toBe('{"type": "string", "enum": ["a","b"],"description":"Allowed: a, b"}')
  })

  it('enum hint fires at any depth and skips non-string or empty enums', () => {
    const cleaned = cleanGeminiSchema(
      '{"properties":{"u":{"enum": ["x"]},"v":{"enum": []},"w":{"enum": [1,2]},"nested":{"enum":["k"]}}}',
    )
    expect(cleaned).toBe('{"properties":{"u":{"enum": ["x"],"description":"Allowed: x"},"v":{"enum": []},"w":{"enum": [1,2]},"nested":{"enum":["k"],"description":"Allowed: k"}}}')
  })

  it('enum hint: hostile values (quotes, <, &) stay JSON-encoded and HTML-escaped in the upstream body', () => {
    const raw = '{"enum": ["AT&T", "5\\" socket", "a<b>"]}'
    const cleaned = cleanGeminiSchema(raw)
    // Both gateway-written strings go through the ordered serializer:
    // quotes are escaped, < > & HTML-escaped, so the body stays valid JSON.
    expect(cleaned).toBe(
      '{"enum": ["AT\\u0026T","5\\" socket","a\\u003cb\\u003e"],' +
        '"description":"Allowed: AT\\u0026T, 5\\" socket, a\\u003cb\\u003e"}',
    )
    const parsed = JSON.parse(cleaned) as { enum: string[]; description: string }
    expect(parsed.enum).toEqual(['AT&T', '5" socket', 'a<b>'])
    expect(parsed.description).toBe('Allowed: AT&T, 5" socket, a<b>')
    // Byte-stable: the same input re-cleans to identical bytes.
    expect(cleanGeminiSchema(raw)).toBe(cleaned)

    // End to end: the upstream body embeds the cleaned schema and still
    // parses as JSON (raw splicing corrupted it before the fix).
    const requestText =
      '{"model":"gm","tools":[{"name":"t","input_schema":{"type":"object","properties":{"q":' +
      '{"enum": ["AT&T", "5\\" socket", "a<b>"]}}}],' +
      '"messages":[{"role":"user","content":"go"}]}'
    const upstream = translate(requestText)
    expect(() => JSON.parse(upstream)).not.toThrow()
    const body = JSON.parse(upstream) as {
      tools: Array<{ functionDeclarations: Array<{ parametersJsonSchema: Record<string, unknown> }> }>
    }
    const schema = body.tools[0]?.functionDeclarations[0]?.parametersJsonSchema
    const property = (schema['properties'] as Record<string, { description?: string }>)['q']
    expect(property?.description).toBe('Allowed: AT&T, 5" socket, a<b>')
    expect(upstream).toContain('\\u0026')
    expect(upstream).toBe(translate(requestText))
  })

  it('functionDeclarations preserve client member bytes and skip schema-less tools', () => {
    const raw =
      '{"tools": [{"name": "get weather", "description": "d", "input_schema": {"type": "object"}}, {"name": "no-schema"}]}'
    const tools = buildFunctionDeclarations(
      [{ name: 'get weather', description: 'd', input_schema: { type: 'object' } }, { name: 'no-schema' }],
      raw,
    )
    const built = serializeOrdered(tools as never)
    expect(built).toBe('{"functionDeclarations":[{"name": "get_weather", "description": "d","parametersJsonSchema":{"type": "object"}}]}')
  })

  it('sanitizeFunctionName ladder: replace, prefix, truncate', () => {
    expect(sanitizeFunctionName('get weather')).toBe('get_weather')
    expect(sanitizeFunctionName('1nvalid-name')).toBe('_1nvalid-name')
    expect(sanitizeFunctionName('a'.repeat(80))).toHaveLength(64)
    expect(sanitizeFunctionName('-lead')).toBe('_-lead'.slice(0, 64))
  })

  it('sanitizeClaudeToolId replaces everything outside [a-zA-Z0-9_-]', () => {
    expect(sanitizeClaudeToolId('get weather-1')).toBe('get_weather-1')
    expect(sanitizeClaudeToolId('a.b/c')).toBe('a_b_c')
  })

  it('restoreToolName: sanitized index, then canonical, then verbatim', () => {
    const index = buildToolNameIndex([
      { name: 'Get Weather' },
      { name: 'other' },
      { name: 'plain' },
      { name: '_weird name' },
    ])
    expect(restoreToolName(index, 'Get_Weather')).toBe('Get Weather')
    expect(restoreToolName(index, '_other')).toBe('other')
    expect(restoreToolName(index, '_weird_name')).toBe('_weird name')
    expect(restoreToolName(index, 'unknown_one')).toBe('unknown_one')
  })
})

// ---------------------------------------------------------------------------
// Message rules (merge, reorder, align, reminder, boundary turns)
// ---------------------------------------------------------------------------

describe('message rules', () => {
  it('tool_result alignment: reordered on one-to-one match, kept otherwise', () => {
    const raw =
      '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"f","input":{}},{"type":"tool_use","id":"a","name":"f","input":{}}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"A"},{"type":"tool_result","tool_use_id":"b","content":"B"}]}]}'
    const matched = JSON.parse(translate(raw)) as { contents: Array<{ parts: unknown[] }> }
    // contents[0] is the leading boundary user turn (model-first request).
    expect(matched.contents[2]?.parts).toEqual([
      { functionResponse: { name: 'f', response: { result: 'B' }, id: 'b' } },
      { functionResponse: { name: 'f', response: { result: 'A' }, id: 'a' } },
    ])

    const mismatched =
      '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"f","input":{}}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"A"},{"type":"tool_result","tool_use_id":"b","content":"B"}]}]}'
    const kept = JSON.parse(translate(mismatched)) as { contents: Array<{ parts: unknown[] }> }
    // Counts differ, so the original order survives; the unmatched id
    // resolves through the dash-strip rung of the name ladder ('a' has no
    // dash, so the id itself becomes the name).
    expect(kept.contents[2]?.parts).toEqual([
      { functionResponse: { name: 'a', response: { result: 'A' }, id: 'a' } },
      { functionResponse: { name: 'f', response: { result: 'B' }, id: 'b' } },
    ])
  })

  it('adjacent user turns merge; consecutive model turns never do', () => {
    const value = translateValue(
      '{"messages":[{"role":"user","content":"a"},{"role":"user","content":"b"},' +
      '{"role":"assistant","content":"1"},{"role":"assistant","content":"2"}]}',
    )
    const contents = value['contents'] as Array<{ role: string; parts: unknown[] }>
    // The merged user turn, two unmerged model turns, then the trailing
    // boundary user turn the executor appends (rule 7).
    expect(contents.map((turn) => turn.role)).toEqual(['user', 'model', 'model', 'user'])
    expect(contents[0]?.parts).toEqual([{ text: 'a' }, { text: 'b' }])
    expect(contents[3]?.parts).toEqual([{ text: '' }])
  })

  it('mid-conversation system turns become reminder text; empty ones drop', () => {
    const value = translateValue(
      '{"messages":[{"role":"user","content":"a"},{"role":"system","content":"note"},{"role":"developer","content":" "},' +
      '{"role":"user","content":"b"}]}',
    )
    const contents = value['contents'] as Array<{ parts: Array<{ text?: string }> }>
    expect(contents).toHaveLength(1)
    expect(contents[0]?.parts.map((part) => part.text)).toEqual([
      'a',
      '<system-reminder>\nnote\n</system-reminder>',
      'b',
    ])
  })

  it('attribution system blocks are stripped in both system forms', () => {
    const stringForm = translateValue(
      '{"system":"x-anthropic-billing-header: cc_version=1;","messages":[{"role":"user","content":"a"}]}',
    )
    expect(stringForm['systemInstruction']).toBeUndefined()
    const arrayForm = translateValue(
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=1;"},{"type":"text","text":"real"}],"messages":[{"role":"user","content":"a"}]}',
    )
    expect(arrayForm['systemInstruction']).toEqual({
      role: 'user',
      parts: [{ text: 'real' }],
    })
    expect(buildSystemInstruction({ system: 'plain' })).toEqual({ parts: [{ text: 'plain' }] })
  })

  it('thinking blocks drop; empty text blocks drop; unknown roles drop the message', () => {
    const value = translateValue(
      '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"hush"},{"type":"text","text":""},{"type":"text","text":"kept"}]},{"role":"ghost","content":"x"}]}',
    )
    const contents = value['contents'] as Array<{ parts: unknown[] }>
    // Boundary turns wrap the surviving model turn (rule 7).
    expect(contents).toHaveLength(3)
    expect(contents[1]?.parts).toEqual([{ text: 'kept' }])
  })

  it('trailing model turn with a functionCall is stripped; plain-text trailing turns survive', () => {
    const withCall = translateValue(
      '{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"f","input":{}}]}]}',
    )
    expect((withCall['contents'] as unknown[]).length).toBe(1)

    const plainTail = translateValue(
      '{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":[{"type":"text","text":"prefill"}]}]}',
    )
    const contents = plainTail['contents'] as Array<{ role: string; parts: unknown[] }>
    // The plain trailing model turn survives and gains the trailing user boundary turn.
    expect(contents.map((turn) => turn.role)).toEqual(['user', 'model', 'user'])
    expect(contents[2]?.parts).toEqual([{ text: '' }])
  })

  it('a model-first conversation gains the leading user boundary turn', () => {
    const value = translateValue('{"messages":[{"role":"assistant","content":"hi"}]}')
    const contents = value['contents'] as Array<{ role: string; parts: unknown[] }>
    expect(contents[0]?.role).toBe('user')
    expect(contents[0]?.parts).toEqual([{ text: '' }])
  })

  it('tool_result name ladder: id match, dash strip, verbatim', () => {
    const raw =
      '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"my func","input":{}}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"A"},{"type":"tool_result","tool_use_id":"get_weather-2","content":"B"},{"type":"tool_result","tool_use_id":"plain","content":"C"}]}]}'
    const value = JSON.parse(translate(raw)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }
    const names = value.contents[2]?.parts.map((part) => (part['functionResponse'] as Record<string, unknown>)['name'])
    expect(names).toEqual(['my_func', 'get_weather', 'plain'])
  })

  it('tool_result result ladder: string, 1 block, 2+ blocks, images only, object, absent', () => {
    const raw =
      '{"messages":[{"role":"user","content":[' +
      '{"type":"tool_result","tool_use_id":"s1","content":"plain"},' +
      '{"type":"tool_result","tool_use_id":"s2","content":[{"type":"text","text":"one"}]},' +
      '{"type":"tool_result","tool_use_id":"s3","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]},' +
      '{"type":"tool_result","tool_use_id":"s4","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"BBB"}}]},' +
      '{"type":"tool_result","tool_use_id":"s5","content":{"k": 1}},' +
      '{"type":"tool_result","tool_use_id":"s6"}]}]}'
    const value = JSON.parse(translate(raw)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }
    const results = value.contents[0]?.parts
      .filter((part) => part['functionResponse'] !== undefined)
      .map((part) => (part['functionResponse'] as Record<string, unknown>)['response'])
    expect(results).toEqual([
      { result: 'plain' },
      { result: { type: 'text', text: 'one' } },
      { result: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { result: '' },
      { result: { k: 1 } },
      { result: '' },
    ])
    // The image became an inline_data part after its own response.
    expect(value.contents[0]?.parts.some((part) => part['inline_data'] !== undefined)).toBe(true)
  })

  it('images with missing pieces and non-base64 sources are skipped', () => {
    const value = translateValue(
      '{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"","data":"x"}},' +
      '{"type":"image","source":{"type":"url","url":"http://x"}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"ok"}}]}]}',
    )
    const contents = value['contents'] as Array<{ parts: unknown[] }>
    expect(contents[0]?.parts).toEqual([{ inline_data: { mime_type: 'image/png', data: 'ok' } }])
  })

  it('tool_use blocks without a valid JSON-object input drop; ids register for later results', () => {
    const raw =
      '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"f","input":"not-an-object"}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"r"}]}]}'
    const value = JSON.parse(translate(raw)) as { contents: Array<{ role: string; parts: unknown[] }> }
    // The malformed call turn vanished (empty), so the result turn resolves by dash-stripping.
    expect(value.contents).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// tool_choice and thinking (two-stage rule)
// ---------------------------------------------------------------------------

describe('tool_choice and thinking', () => {
  it('tool_choice ladder', () => {
    expect(buildToolConfig({ tool_choice: 'auto' })).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
    expect(buildToolConfig({ tool_choice: { type: 'none' } })).toEqual({ functionCallingConfig: { mode: 'NONE' } })
    expect(buildToolConfig({ tool_choice: { type: 'any' } })).toEqual({ functionCallingConfig: { mode: 'ANY' } })
    expect(buildToolConfig({ tool_choice: { type: 'tool', name: 'get weather' } })).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    })
    expect(buildToolConfig({ tool_choice: { type: 'weird' } })).toBeUndefined()
    expect(buildToolConfig({})).toBeUndefined()
  })

  it('stage 1 maps thinking shapes; sampling accepts numbers only', () => {
    const enabled = buildGenerationConfig(
      { thinking: { type: 'enabled', budget_tokens: 512 }, temperature: 0.5, top_p: 'x', top_k: 3 },
      ctx({ kind: 'budget', min: 0, max: 1024 }),
    )
    expect(enabled).toEqual({
      temperature: 0.5,
      topK: 3,
      thinkingConfig: { thinkingBudget: 512 },
    })
    const effort = buildGenerationConfig(
      { thinking: { type: 'adaptive' }, output_config: { effort: ' High ' } },
      ctx({ kind: 'levels', levels: ['low', 'high'] }),
    )
    expect(effort).toEqual({ thinkingConfig: { thinkingLevel: 'high' } })
    const adaptiveBudget = buildGenerationConfig({ thinking: { type: 'adaptive' } }, ctx({ kind: 'budget', min: 0, max: 4096 }))
    expect(adaptiveBudget).toEqual({ thinkingConfig: { thinkingBudget: 4096 } })
    const adaptiveHigh = buildGenerationConfig({ thinking: { type: 'auto' } }, ctx(undefined))
    expect(adaptiveHigh).toEqual({ thinkingConfig: { thinkingLevel: 'high' } })
  })

  it('stage 2 strips thinkingConfig for capability-resolved models, keeping generationConfig:{}', () => {
    const stripped = buildGenerationConfig({ thinking: { type: 'enabled', budget_tokens: 1024 } }, ctx({ kind: 'unsupported' }))
    expect(stripped).toEqual({})
    const kept = buildGenerationConfig({ thinking: { type: 'enabled', budget_tokens: 1024 } }, ctx(undefined))
    expect(kept).toEqual({ thinkingConfig: { thinkingBudget: 1024 } })
    const mixed = buildGenerationConfig(
      { thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 1 },
      ctx({ kind: 'unsupported' }),
    )
    expect(mixed).toEqual({ temperature: 1 })
    expect(buildGenerationConfig({ temperature: 1 }, ctx({ kind: 'unsupported' }))).toEqual({ temperature: 1 })
    expect(buildGenerationConfig({}, ctx({ kind: 'unsupported' }))).toBeUndefined()
  })

  it('capability-resolved models lose thinkingConfig; user-defined contexts keep it (S2d8-07/10 pin the strip; the facade maps plain entries to the strip)', () => {
    const stripped = translate(
      { model: 'gm', thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'q' }] },
      { kind: 'unsupported' },
    )
    expect(stripped).toContain('"generationConfig":{}')
    const userDefined = translate(
      { model: 'gm', thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'q' }] },
      undefined,
    )
    expect(userDefined).toContain('"thinkingConfig":{"thinkingBudget":1024}')
  })

  it('max_tokens, stop_sequences and metadata never reach the wire; session_id never survives', () => {
    const body = translate({
      model: 'gm',
      max_tokens: 100,
      stop_sequences: ['END'],
      metadata: { user_id: 'u' },
      stream: true,
      session_id: 'zz',
      messages: [{ role: 'user', content: 'a' }],
    })
    expect(body).not.toContain('maxOutputTokens')
    expect(body).not.toContain('stopSequences')
    expect(body).not.toContain('metadata')
    expect(body).not.toContain('"stream"')
    expect(body).not.toContain('session_id')
  })
})

// ---------------------------------------------------------------------------
// countTokens body variant (section 3.2.12)
// ---------------------------------------------------------------------------

describe('countTokens body variant', () => {
  it('the strip list is exactly {tools, generationConfig, safetySettings}; toolConfig is RETAINED (S2d8-21)', () => {
    const raw =
      '{"model":"gm","system":"sys","temperature":0.5,"tool_choice":{"type":"auto"},' +
      '"tools":[{"name":"t","input_schema":{"type":"object"}}],' +
      '"messages":[{"role":"assistant","content":"prefill"}]}'
    const translated = translateClaudeToGemini(raw, ctx(), { forCountTokens: true })
    const value = JSON.parse(translated.body) as Record<string, unknown>
    // S2d8-21 pins toolConfig.functionCallingConfig on the :countTokens
    // wire when the client carries tool_choice.
    expect(Object.keys(value)).toEqual(['contents', 'model', 'systemInstruction', 'toolConfig'])
    expect(value['systemInstruction']).toEqual({ parts: [{ text: 'sys' }] })
    expect(value['toolConfig']).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
    // Prepend-only boundary: the model-first request gains the leading user
    // turn but NO trailing one in this variant.
    const contents = value['contents'] as Array<{ role: string }>
    expect(contents.map((turn) => turn.role)).toEqual(['user', 'model'])
    const normal = translateClaudeToGemini(raw, ctx())
    expect((JSON.parse(normal.body) as Record<string, unknown>)['contents']).toHaveLength(3)
    // The absent side (S2d8-13): a request without tool_choice emits no
    // toolConfig key on either path.
    const bare = translateClaudeToGemini(
      '{"model":"gm","system":"s","messages":[{"role":"user","content":"hi"}]}',
      ctx(),
      { forCountTokens: true },
    )
    expect(Object.keys(JSON.parse(bare.body) as Record<string, unknown>)).toEqual([
      'contents',
      'model',
      'systemInstruction',
    ])
  })
})

// ---------------------------------------------------------------------------
// Response mapping (non-stream, section 3.4)
// ---------------------------------------------------------------------------

function responseContext(body: string, tools: readonly unknown[] = []): GeminiToClaudeContext {
  return {
    upstreamBody: body,
    toolNames: buildToolNameIndex(tools as never),
  }
}

describe('non-stream response mapping', () => {
  it('maps the template with buffers flushing at type switches', () => {
    const upstream = JSON.stringify({
      responseId: 'resp-1',
      modelVersion: 'gemini-x',
      candidates: [
        {
          content: {
            parts: [
              { text: 'think-a', thought: true, thoughtSignature: 'sig1' },
              { text: 'answer', thought: true },
              { text: 'plain' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 4, cachedContentTokenCount: 3 },
    })
    const body = translateGeminiResponseToClaude(responseContext(upstream))
    expect(body).toBe(
      '{"id":"resp-1","type":"message","role":"assistant","model":"gemini-x",' +
        // Consecutive thought parts buffer into ONE thinking block; only
        // type switches flush (section 3.4).
        '"content":[{"type":"thinking","thinking":"think-aanswer","signature":"sig1"},' +
        '{"type":"text","text":"plain"}],' +
        '"stop_reason":"end_turn","stop_sequence":null,' +
        '"usage":{"input_tokens":17,"output_tokens":9,"cache_read_input_tokens":3}}',
    )
  })

  it('empty id/model fall back to empty strings; absent usageMetadata deletes the usage key', () => {
    const upstream = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'truncated ans' }] }, finishReason: 'MAX_TOKENS' }],
    })
    const body = translateGeminiResponseToClaude(responseContext(upstream))
    expect(body).toBe(
      '{"id":"","type":"message","role":"assistant","model":"","content":[{"type":"text","text":"truncated ans"}],' +
        '"stop_reason":"max_tokens","stop_sequence":null}',
    )
  })

  it('functionCalls become tool_use blocks with restored names and counter ids', () => {
    const upstream = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
              { functionCall: { name: 'get_weather' } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    })
    const body = translateGeminiResponseToClaude(responseContext(upstream, [{ name: 'get weather' }]))
    expect(body).toContain('"stop_reason":"tool_use"')
    expect(body).toContain('"id":"get_weather-1","name":"get weather","input":{"city":"Paris"}')
    expect(body).toContain('"id":"get_weather-2","name":"get weather","input":{}')
  })

  it('usage helpers and stop-reason ladder', () => {
    expect(readGeminiUsage(undefined)).toEqual({ prompt: 0, candidates: 0, thoughts: 0, cached: 0 })
    expect(claudeUsageObject({ prompt: 10, candidates: 2, thoughts: 0, cached: 12 })).toEqual({
      input_tokens: 0,
      output_tokens: 2,
      cache_read_input_tokens: 12,
    })
    expect(claudeStopReason(true, 'MAX_TOKENS')).toBe('tool_use')
    expect(claudeStopReason(false, 'MAX_TOKENS')).toBe('max_tokens')
    expect(claudeStopReason(false, 'STOP')).toBe('end_turn')
    expect(claudeStopReason(false, undefined)).toBe('end_turn')
  })

  it('an unparseable upstream body renders the empty template', () => {
    const body = translateGeminiResponseToClaude(responseContext('not json'))
    expect(body).toBe(
      '{"id":"","type":"message","role":"assistant","model":"","content":[],"stop_reason":"end_turn","stop_sequence":null}',
    )
  })

  it('an over-deep functionCall input surfaces invalid-input instead of an escaping RangeError', () => {
    const deepArgs = '{"a":'.repeat(15_000) + '1' + '}'.repeat(15_000)
    const upstream =
      '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":' + deepArgs + '}}]},"finishReason":"STOP"}]}'
    let caught: unknown
    try {
      translateGeminiResponseToClaude(responseContext(upstream))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CpaError)
    expect((caught as CpaError).code).toBe('invalid-input')
  })
})

// ---------------------------------------------------------------------------
// Stream state machine (section 3.5)
// ---------------------------------------------------------------------------

function chunkTranslator(inputTokens = 0, tools: readonly unknown[] = []): GeminiToClaudeStreamTranslator {
  return new GeminiToClaudeStreamTranslator({
    inputTokens,
    toolNames: buildToolNameIndex(tools as never),
  })
}

function sse(...chunks: readonly unknown[]): Uint8Array[] {
  return chunks.map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
}

async function collect(iterable: AsyncIterable<string | Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const frame of decodeUpstreamDataLines(iterable)) out.push(frame.data)
  return out
}

describe('stream state machine', () => {
  it('message_start fires once with defaults, the estimate and the chunk overrides', async () => {
    const translator = chunkTranslator(9)
    const first = translator.translateChunk(JSON.stringify({ modelVersion: 'gemini-x', candidates: [{ content: { parts: [{ text: 'hi' }] } }] }))
    expect(first).toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY","type":"message","role":"assistant","content":[],"model":"gemini-x","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}\n\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n\n',
    )
    const second = translator.translateChunk(JSON.stringify({ responseId: 'late' }))
    expect(second).toBe('')
  })

  it('thinking parts emit thinking and signature deltas; the gate closes and summarizes', () => {
    const translator = chunkTranslator(4)
    translator.translateChunk(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a', thought: true }] } }] }))
    const out = translator.translateChunk(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'b', thought: true, thoughtSignature: 's' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, thoughtsTokenCount: 2 },
      }),
    )
    expect(out).toContain('"type":"thinking_delta","thinking":"b"')
    expect(out).toContain('"type":"signature_delta","signature":"s"')
    expect(out).toContain('"stop_reason":"max_tokens","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":3}')
    expect(out).toContain('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}')
    // The gate never fires twice.
    const again = translator.translateChunk(
      JSON.stringify({ usageMetadata: { promptTokenCount: 9 }, candidates: [{ finishReason: 'STOP' }] }),
    )
    expect(again).not.toContain('message_delta')
  })

  it('mid-stream usageMetadata without finishReason is filtered out of the gate', () => {
    const translator = chunkTranslator(0)
    translator.translateChunk(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }))
    const out = translator.translateChunk(JSON.stringify({ usageMetadata: { promptTokenCount: 50 } }))
    expect(out).toBe('')
    const finish = translator.translateChunk(
      JSON.stringify({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2 }, candidates: [{ finishReason: 'STOP' }] }),
    )
    expect(finish).toContain('message_delta')
  })

  it('a stream with no content events ends after message_start', () => {
    const translator = chunkTranslator(4)
    translator.translateChunk(JSON.stringify({ modelVersion: 'm', candidates: [{ content: { parts: [] } }] }))
    const tail = translator.handleStreamEnd()
    expect(tail).toBe('')
  })

  it('empty-name follow-up calls become input_json_delta of the open block', () => {
    const translator = chunkTranslator(32, [{ name: 'get weather' }])
    translator.translateChunk(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { a: 1 } } }] } }] }))
    const delta = translator.translateChunk(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: '', args: { b: 2 } } }] } }] }))
    expect(delta).toBe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":2}"}}\n\n\n',
    )
  })

  it('transport failure renders the [DONE] pass plus one 2-newline terminal frame', () => {
    const translator = chunkTranslator(4)
    translator.translateChunk(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }))
    const tail = translator.handleTransportFailure('unexpected EOF')
    expect(tail).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n\n' +
        'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}\n\n',
    )
  })

  it('framing helpers and event templates', () => {
    expect(formatClaudeEvent('message_stop', '{"type":"message_stop"}')).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n\n',
    )
    expect(formatTerminalErrorEvent('boom')).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n',
    )
    expect(frameDownstream({ kind: 'chunk', payload: 'P' })).toBe('P')
    expect(frameDownstream({ kind: 'terminal-error', message: 'boom' })).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n',
    )
  })

  it('the pipeline surfaces a dead stream pre-commit and translates the rest in order', async () => {
    const emptySource = (async function* () {
      yield* sse()
    })()
    const dead = await bootstrapCla2GemStream(emptySource, { inputTokens: 0, toolNames: buildToolNameIndex([]) })
    expect(dead.kind).toBe('dead')
    const live = await bootstrapCla2GemStream(
      (async function* () { yield* sse({ modelVersion: 'm', candidates: [{ content: { parts: [{ text: 'a' }] } }] }) })(),
      { inputTokens: 0, toolNames: buildToolNameIndex([]) },
    )
    expect(live.kind).toBe('live')
    if (live.kind !== 'live') return
    const rest: string[] = [live.firstFrame.kind === 'chunk' ? live.firstFrame.payload : 'terminal']
    for await (const frame of live.rest) {
      rest.push(frame.kind === 'chunk' ? frame.payload : 'terminal')
    }
    expect(rest[0]).toContain('message_start')
    expect(rest.length).toBe(2)
  })

  it('decoded upstream data lines skip events, comments and [DONE]', async () => {
    const lines = await collect(
      (async function* () {
        yield ': keep-alive\n\n'
        yield 'event: x\n'
        yield 'data: {"a":1}\n\n'
        yield 'data: [DONE]\n\n'
        yield 'data: {"b":2}'
      })(),
    )
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })
})

// ---------------------------------------------------------------------------
// Token estimate (R-TOK, ruling S2d8-1)
// ---------------------------------------------------------------------------

describe('input-token estimate', () => {
  it('recorded values reproduce byte-exactly (4/9/32)', () => {
    expect(
      estimateClaudeInputTokens({
        model: 'gm',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    ).toBe(4)
    expect(
      estimateClaudeInputTokens({
        model: 'gm',
        max_tokens: 2048,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'What is 6*7?' }],
      }),
    ).toBe(9)
    expect(
      estimateClaudeInputTokens({
        model: 'gm',
        max_tokens: 1024,
        stream: true,
        tools: [
          {
            name: 'get weather',
            description: 'Get current weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
      }),
    ).toBe(32)
  })

  it('segments cover system, block tables, tools and tool_choice', () => {
    const segments = claudeRequestSegments({
      system: [{ type: 'text', text: 'be terse' }],
      messages: [
        { role: 'user', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } }] },
        { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      ],
      tools: [{ type: 'custom', name: 'f', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'f' },
    })
    expect(segments).toEqual([
      'be terse',
      'user',
      't1',
      'f',
      '{"x":1}',
      'assistant',
      't1',
      'done',
      'custom',
      'f',
      'd',
      '{"type":"object"}',
      'tool',
      'f',
    ])
  })
})

// ---------------------------------------------------------------------------
// Error semantics (section 4)
// ---------------------------------------------------------------------------

describe('error semantics', () => {
  it('status ladder maps to Claude types', () => {
    expect(claudeErrorTypeForStatus(401)).toBe('authentication_error')
    expect(claudeErrorTypeForStatus(402)).toBe('billing_error')
    expect(claudeErrorTypeForStatus(403)).toBe('permission_error')
    expect(claudeErrorTypeForStatus(404)).toBe('not_found_error')
    expect(claudeErrorTypeForStatus(413)).toBe('request_too_large')
    expect(claudeErrorTypeForStatus(429)).toBe('rate_limit_error')
    expect(claudeErrorTypeForStatus(504)).toBe('timeout_error')
    expect(claudeErrorTypeForStatus(529)).toBe('overloaded_error')
    expect(claudeErrorTypeForStatus(500)).toBe('api_error')
    expect(claudeErrorTypeForStatus(400)).toBe('invalid_request_error')
  })

  it('message extraction ladder', () => {
    expect(extractClaudeError(429, '{"error":{"code":429,"message":"mock rate limit"}}')).toEqual({
      type: 'rate_limit_error',
      message: 'mock rate limit',
    })
    expect(extractClaudeError(400, '{"error":{"code":"EA_400"}}')).toEqual({
      type: 'invalid_request_error',
      message: 'EA_400',
    })
    expect(extractClaudeError(400, '{"error":{"code":400}}')).toEqual({
      type: 'invalid_request_error',
      message: '{"error":{"code":400}}',
    })
    expect(extractClaudeError(500, '{"error":{"type":"oops","message":"m"}}')).toEqual({
      type: 'oops',
      message: 'm',
    })
    expect(extractClaudeError(400, '{"type":"invalid_request_error","message":"top"}')).toEqual({
      type: 'invalid_request_error',
      message: 'top',
    })
    expect(extractClaudeError(502, 'plain text')).toEqual({ type: 'api_error', message: 'plain text' })
    expect(extractClaudeError(502, '')).toEqual({ type: 'api_error', message: 'Bad Gateway' })
  })

  it('envelope and cooldown surfaces', () => {
    expect(buildClaudeErrorEnvelope('rate_limit_error', 'mock rate limit')).toBe(
      '{"type":"error","error":{"type":"rate_limit_error","message":"mock rate limit"}}',
    )
    const cooldown = buildModelCooldownResponse({ model: 'gm', lastUpstreamError: 'rate limited' })
    expect(cooldown.status).toBe(500)
    expect(cooldown.body).toBe(
      '{"type":"error","error":{"type":"api_error","message":"All credentials for model gm are cooling down via provider gemini (last error: rate limited)"}}',
    )
  })
})

// ---------------------------------------------------------------------------
// Upstream headers (section 2.2)
// ---------------------------------------------------------------------------

describe('upstream headers', () => {
  it('pinned set and order; no Accept, no Authorization', () => {
    const headers = buildGeminiUpstreamHeaders({
      apiKey: 'k',
      url: `${BASE}/v1beta/models/m:generateContent`,
      body: '{"a":1}',
    })
    expect(headers).toEqual([
      ['Host', 'mock.internal:19001'],
      ['User-Agent', 'Go-http-client/1.1'],
      ['Content-Length', '7'],
      ['Content-Type', 'application/json'],
      ['X-Goog-Api-Key', 'k'],
      ['Accept-Encoding', 'gzip'],
    ])
    expect(headers.some(([name]) => name.toLowerCase() === 'accept')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Service facade gates
// ---------------------------------------------------------------------------

function serviceRequest(path: string, body: string, key = 'Authorization: Bearer oracle-local-key-1'): Cla2GemRequest {
  const headers: Array<[string, string]> = []
  if (key !== '') headers.push(key.split(': ') as [string, string])
  headers.push(['Content-Type', 'application/json'])
  return { method: 'POST', path, headers, body }
}

function jsonResponse(status: number, body: string): Cla2GemUpstreamResponse {
  return { status, headers: [], body: new Response(body).body as ReadableStream<Uint8Array> }
}

async function readBody(response: Cla2GemResponse): Promise<string> {
  if (typeof response.body === 'string') return response.body
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

function facade(store = new MemoryStore()) {
  return createCla2GemService({
    apiKeys: ['oracle-local-key-1'],
    credentials: [{ apiKey: 'mock-gem-key', baseUrl: BASE, models: [{ name: UPSTREAM_MODEL, alias: 'gm' }] }],
    store,
    now: () => 1_789_504_384_000,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
}

describe('service facade', () => {
  it('wrong method or path yields the R-404 empty 404', async () => {
    const service = facade()
    expect(await service.handleV1Messages(serviceRequest('/v1/messages', '{}'), async () => { throw new Error('unused') })).toBeDefined()
    const wrongMethod = await facade().handleV1Messages(
      { ...serviceRequest('/v1/messages', '{}'), method: 'GET' },
      async () => { throw new Error('unused') },
    )
    expect(wrongMethod.status).toBe(404)
    expect(wrongMethod.body).toBe('')
    const wrongPath = await facade().handleV1Messages(
      serviceRequest('/v1/other', '{}'),
      async () => { throw new Error('unused') },
    )
    expect(wrongPath.status).toBe(404)
  })

  it('gateway key gate: missing and invalid keys', async () => {
    const missing = await facade().handleV1Messages(
      { method: 'POST', path: '/v1/messages', headers: [], body: '{"model":"gm"}' },
      async () => { throw new Error('unused') },
    )
    expect(missing.status).toBe(401)
    expect(missing.body).toBe('{"error":"Missing API key"}')
    const invalid = await facade().handleV1Messages(serviceRequest('/v1/messages', '{"model":"gm"}', 'Authorization: Bearer nope'), async () => { throw new Error('unused') })
    expect(invalid.status).toBe(401)
    expect(invalid.body).toBe('{"error":"Invalid API key"}')
  })

  it('alias-only routing: the upstream name and unknown ids reject with zero dispatch (S2d8-19/20)', async () => {
    const service = facade()
    let calls = 0
    const send: Cla2GemUpstreamSender = async () => {
      calls += 1
      return jsonResponse(200, '{}')
    }
    const name = await service.handleV1Messages(
      serviceRequest('/v1/messages', '{"model":"gemini-mock-model","messages":[]}'),
      send,
    )
    expect(name.status).toBe(400)
    expect(name.body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model gemini-mock-model"}}',
    )
    const malformed = await service.handleV1Messages(serviceRequest('/v1/messages', 'this is not json'), send)
    expect(malformed.status).toBe(400)
    expect(malformed.body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model"}}',
    )
    expect(calls).toBe(0)
  })

  it('429 cools the credential down for ~1s; the next request gets the cooldown surface', async () => {
    const store = new MemoryStore()
    const service = facade(store)
    const bodies = [
      jsonResponse(429, '{"error":{"code":429,"message":"mock rate limit"}}'),
      jsonResponse(200, '{}'),
    ]
    let attempt = 0
    const send: Cla2GemUpstreamSender = async () => {
      const reply = bodies[attempt]
      attempt += 1
      if (reply === undefined) throw new Error('no scripted reply')
      return reply
    }
    const first = await service.handleV1Messages(
      serviceRequest('/v1/messages', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
      send,
    )
    expect(first.status).toBe(429)
    expect(first.body).toBe('{"type":"error","error":{"type":"rate_limit_error","message":"mock rate limit"}}')
    const second = await service.handleV1Messages(
      serviceRequest('/v1/messages', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
      send,
    )
    expect(second.status).toBe(500)
    expect(second.body).toBe(
      '{"type":"error","error":{"type":"api_error","message":"All credentials for model gm are cooling down via provider gemini (last error: {\\"error\\":{\\"code\\":429,\\"message\\":\\"mock rate limit\\"}})"}}',
    )
    expect(attempt).toBe(1)
  })

  it('non-stream upstream errors pass the status through with the Claude envelope', async () => {
    const service = facade()
    const send: Cla2GemUpstreamSender = async () => jsonResponse(503, 'upstream exploded')
    const response = await service.handleV1Messages(
      serviceRequest('/v1/messages', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
      send,
    )
    expect(response.status).toBe(503)
    expect(await readBody(response)).toBe(
      '{"type":"error","error":{"type":"api_error","message":"upstream exploded"}}',
    )
  })

  it('count_tokens reaches a real upstream :countTokens call', async () => {
    const service = facade()
    const calls: Cla2GemUpstreamRequest[] = []
    const send: Cla2GemUpstreamSender = async (call) => {
      calls.push(call)
      expect(call.url).toBe(`${BASE}/v1beta/models/${UPSTREAM_MODEL}:countTokens`)
      return jsonResponse(200, '{"totalTokens":42}')
    }
    const response = await service.handleV1Messages(
      serviceRequest('/v1/messages/count_tokens', '{"model":"gm","system":"s","messages":[{"role":"user","content":"Hello world"}]}'),
      send,
    )
    expect(await readBody(response)).toBe('{"input_tokens":42}')
    expect(calls.length).toBe(1)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
      model: UPSTREAM_MODEL,
      systemInstruction: { parts: [{ text: 's' }] },
    })
  })

  it('$alt passthrough lands on non-stream URLs only', async () => {
    const service = facade()
    const calls: Cla2GemUpstreamRequest[] = []
    const send: Cla2GemUpstreamSender = async (call) => {
      calls.push(call)
      return jsonResponse(200, '{"candidates":[]}')
    }
    await service.handleV1Messages(
      serviceRequest('/v1/messages?$alt=debug', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
      send,
    )
    expect(calls[0]?.url).toBe(`${BASE}/v1beta/models/${UPSTREAM_MODEL}:generateContent?$alt=debug`)
    calls.length = 0
    await service.handleV1Messages(
      serviceRequest('/v1/messages?alt=sse', '{"model":"gm","stream":true,"messages":[{"role":"user","content":"a"}]}'),
      send,
    )
    expect(calls[0]?.url).toBe(`${BASE}/v1beta/models/${UPSTREAM_MODEL}:streamGenerateContent?alt=sse`)
  })

  it('a failing Store READ fails the cooldown gate OPEN and surfaces through reportError (B1)', async () => {
    const failingStore: Store = {
      get: async () => {
        throw new Error('store read down')
      },
      put: async () => undefined,
      delete: async () => false,
      list: async () => [],
      update: async () => {
        throw new Error('unused')
      },
      enqueue: async () => 'id',
      claim: async () => undefined,
      ack: async () => true,
      release: async () => true,
      ringAppend: async () => undefined,
      ringRead: async () => [],
    }
    const reported: unknown[] = []
    const original = globalThis.reportError
    globalThis.reportError = (error: unknown) => {
      reported.push(error)
    }
    try {
      const service = facade(failingStore)
      const send: Cla2GemUpstreamSender = async () =>
        jsonResponse(
          200,
          '{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}',
        )
      const response = await service.handleV1Messages(
        serviceRequest('/v1/messages', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
        send,
      )
      expect(response.status).toBe(200)
      expect(await readBody(response)).toBe(
        '{"id":"","type":"message","role":"assistant","model":"","content":[{"type":"text","text":"ok"}],' +
          '"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}',
      )
      expect(reported.length).toBe(1)
      expect((reported[0] as Error).message).toBe('store read down')
    } finally {
      globalThis.reportError = original
    }
  })

  it('a cooling credential with a healthy Store still gates the request (zero dispatch)', async () => {
    const store = new MemoryStore()
    await store.put('cla2gem', 'credential-cooldown:0', {
      until_ms: 1_789_504_384_000 + 60_000,
      last_upstream_error: 'rate limited',
    })
    const service = facade(store)
    const response = await service.handleV1Messages(
      serviceRequest('/v1/messages', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(response.status).toBe(500)
    expect(response.body).toBe(
      '{"type":"error","error":{"type":"api_error","message":"All credentials for model gm are cooling down via provider gemini (last error: rate limited)"}}',
    )
  })

  it('an over-deep tool argument renders the 400 envelope with zero upstream dispatch, stream or not (N3)', async () => {
    const service = facade()
    const calls: Cla2GemUpstreamRequest[] = []
    const send: Cla2GemUpstreamSender = async (call) => {
      calls.push(call)
      throw new Error('must not be called')
    }
    const deepInput = '{"a":'.repeat(15_000) + '1' + '}'.repeat(15_000)
    const streamed = await service.handleV1Messages(
      serviceRequest(
        '/v1/messages',
        '{"model":"gm","stream":true,"messages":[{"role":"user","content":[{"type":"tool_use","id":"t","name":"f","input":' +
          deepInput +
          '}]}]}',
      ),
      send,
    )
    expect(streamed.status).toBe(400)
    expect(streamed.body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"JSON nesting exceeds the maximum depth of 10000 levels"}}',
    )
    const aggregated = await service.handleV1Messages(
      serviceRequest(
        '/v1/messages',
        '{"model":"gm","messages":[{"role":"user","content":[{"type":"tool_use","id":"t","name":"f","input":' +
          deepInput +
          '}]}]}',
      ),
      send,
    )
    expect(aggregated.status).toBe(400)
    expect(aggregated.body).toBe(streamed.body)
    expect(calls.length).toBe(0)
  })

  it('a deep-but-legal tool argument still translates and streams (the cap does not over-reject)', async () => {
    const service = facade()
    const deepInput = '{"a":'.repeat(2_000) + '1' + '}'.repeat(2_000)
    const sseReply = 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}]}}\n\n'
    const send: Cla2GemUpstreamSender = async () => ({
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: new Response(sseReply).body as ReadableStream<Uint8Array>,
    })
    const response = await service.handleV1Messages(
      serviceRequest(
        '/v1/messages',
        '{"model":"gm","stream":true,"messages":[{"role":"user","content":[{"type":"tool_use","id":"t","name":"f","input":' +
          deepInput +
          '}]}]}',
      ),
      send,
    )
    expect(response.status).toBe(200)
    const text = await readBody(response)
    expect(text).toContain('event: message_start')
    expect(text).toContain('"type":"text_delta","text":"hi"')
  })

  it('an over-deep upstream functionCall in a streamed reply renders the pre-commit 500, not a crash', async () => {
    const service = facade()
    const deepArgs = '{"a":'.repeat(15_000) + '1' + '}'.repeat(15_000)
    const sseReply =
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":' + deepArgs + '}}]}}]}
    const sseReply =
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":' + deepArgs + '}]}}]}\n\n'
      headers: [['Content-Type', 'text/event-stream']],
      body: new Response(sseReply).body as ReadableStream<Uint8Array>,
    })
    const response = await service.handleV1Messages(
      serviceRequest('/v1/messages', '{"model":"gm","stream":true,"messages":[{"role":"user","content":"a"}]}'),
      send,
    )
    expect(response.status).toBe(500)
    expect(await readBody(response)).toBe(
      '{"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}',
    )
  })

  it('count_tokens: a 2xx non-JSON body still renders {"input_tokens":0} and surfaces the parse failure (N7)', async () => {
    const reported: unknown[] = []
    const original = globalThis.reportError
    globalThis.reportError = (error: unknown) => {
      reported.push(error)
    }
    try {
      const service = facade()
      const send: Cla2GemUpstreamSender = async () => jsonResponse(200, '<html>not json</html>')
      const response = await service.handleV1Messages(
        serviceRequest('/v1/messages/count_tokens', '{"model":"gm","messages":[{"role":"user","content":"a"}]}'),
        send,
      )
      expect(response.status).toBe(200)
      expect(await readBody(response)).toBe('{"input_tokens":0}')
      expect(reported.length).toBe(1)
      expect((reported[0] as Error).name).toBe('SyntaxError')
    } finally {
      globalThis.reportError = original
    }
  })
})

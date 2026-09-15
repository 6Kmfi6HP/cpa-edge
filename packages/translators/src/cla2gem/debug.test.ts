
import { it } from 'vitest'
import { translateClaudeToGemini } from './request'
import { readFileSync } from 'node:fs'
it('debug', () => {
  const body = readFileSync('tests/fixtures/S2d8/S2d8-11-stream-tool-call/request.http', 'utf8').replace(/\r\n/g, '\n')
  const json = body.slice(body.indexOf('\n\n')).trim()
  const out = translateClaudeToGemini(json, { upstreamModel: 'gemini-mock-model', thinking: { kind: 'unsupported' } })
  const rec = JSON.parse(readFileSync('tests/fixtures/S2d8/S2d8-11-stream-tool-call/upstream.jsonl', 'utf8'))
  const expected = rec.body
  let i = 0
  while (i < Math.min(out.body.length, expected.length) && out.body[i] === expected[i]) i++
  console.log('first diff at', i)
  console.log('expected:', JSON.stringify(expected.slice(Math.max(0,i-40), i+60)))
  console.log('received:', JSON.stringify(out.body.slice(Math.max(0,i-40), i+60)))
})


import { test } from 'vitest'
import { readCase } from './fixture-reader'
import { rawSpanAt, scanArrayElements } from './json'

test('trace elements on real body', () => {
  const c = readCase('S2d9-04')
  const body = c.request.body
  const toolsSpan = rawSpanAt(body, ['tools'])!
  const elements = scanArrayElements(body, toolsSpan)
  const el1 = elements![1]!
  console.log('EL1 span: ' + JSON.stringify(el1.span))
  console.log('EL1 text: ' + JSON.stringify(body.slice(el1.span.start, el1.span.end)))
  // simulate the rewrite exactly as rewriteToolElementType does
  const objectText = body.slice(el1.span.start, el1.span.end)
  console.log('objectText len: ' + objectText.length + ' span.end-start: ' + (el1.span.end - el1.span.start))
})

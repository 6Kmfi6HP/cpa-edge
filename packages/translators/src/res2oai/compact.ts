/**
 * Compact passthrough translation (S2d6 section 2.4).
 *
 * `POST /v1/responses/compact` has no registered translator pair, so the
 * original client body travels upstream with exactly two edits: the
 * `model` member is overwritten with the resolved upstream name and the
 * `stream` member is deleted (even when the client sent `stream:false`).
 * Every other byte of the body - spacing, key order, nested values -
 * survives verbatim.
 */
import { scanObjectMembers, serializeOrdered } from './json'

/** One byte-level edit of the passthrough body. */
interface BodyEdit {
  readonly start: number
  readonly end: number
  readonly replacement: string
}

/**
 * Rewrites the compact request body: `model` -> resolved upstream name,
 * `stream` removed. Bodies that do not open a JSON object pass through
 * unchanged (the strict boundary already rejected non-JSON upstream).
 */
export function translateCompactPassthrough(body: string, upstreamModel: string): string {
  const members = scanObjectMembers(body)
  if (members === undefined) return body
  const edits: BodyEdit[] = []
  for (let index = 0; index < members.length; index++) {
    const member = members[index]
    if (member === undefined) continue
    if (member.name === 'model') {
      edits.push({ start: member.valueStart, end: member.valueEnd, replacement: serializeOrdered(upstreamModel) })
      continue
    }
    if (member.name !== 'stream') continue
    if (index === 0) {
      edits.push({ start: member.keyStart, end: trailingSeparatorEnd(body, member.valueEnd), replacement: '' })
    } else {
      edits.push({ start: precedingSeparatorStart(body, member.keyStart), end: member.valueEnd, replacement: '' })
    }
  }
  if (edits.length === 0) return body
  let out = body
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  }
  return out
}

/** Index where the separator in front of a member starts (the comma, whitespace included). */
function precedingSeparatorStart(body: string, keyStart: number): number {
  let i = keyStart
  while (i > 0 && isSpace(body[i - 1])) i--
  if (i > 0 && body[i - 1] === ',') i -= 1
  return i
}

/** Index one past the separator following a member (the comma, whitespace included). */
function trailingSeparatorEnd(body: string, valueEnd: number): number {
  let i = valueEnd
  while (i < body.length && isSpace(body[i])) i++
  if (body[i] === ',') i += 1
  return i
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

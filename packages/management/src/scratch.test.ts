
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { createManagementApi } from './api'
import { MemoryStore } from '@cpa-edge/core'

const S5_ROOT = new URL('../../../tests/fixtures/S5/', import.meta.url)

const SECTION_HEAD_RE = /^(\S+) ((?:STEP \d+)|(?:AUX-\d+)) — (\S+) (\S+)(.*)$/
const STATUS_BLOCK_RE = /### Status \+ response headers \(received order\)\n```\n([\s\S]*?)\n```\n/
const BODY_BLOCK_RE = /### Body\n```\n([\s\S]*?)\n?```\n/

function byteLength(text: string): number { return new TextEncoder().encode(text).length }

function reconstructWireBytes(rendered: string, contentLength: number, multipart: boolean): string {
  const candidates = [rendered, `${rendered}\n`]
  if (multipart) {
    const crlf = rendered.replaceAll('\n', '\r\n')
    candidates.push(crlf, `${crlf}\r\n`)
  }
  for (const candidate of candidates) {
    if (byteLength(candidate) === contentLength) return candidate
  }
  throw new Error(`cannot reconstruct ${contentLength}`)
}

function parseRequestHttp(text: string): any[] {
  const sections: any[] = []
  for (const part of text.split(/^### /m).slice(1)) {
    const lines = part.split('\n')
    const m = SECTION_HEAD_RE.exec(lines[0])
    if (!m) throw new Error('bad head')
    const headers: Array<[string, string]> = []
    let i = 2
    while (i < lines.length && lines[i] !== '') {
      const sep = lines[i].indexOf(': ')
      headers.push([lines[i].slice(0, sep), lines[i].slice(sep + 2)])
      i += 1
    }
    i += 1
    const bodyLines = lines.slice(i)
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
    const rendered = bodyLines.join('\n')
    const cl = headers.find(([n]) => n.toLowerCase() === 'content-length')?.[1]
    const body = cl === undefined ? '' : reconstructWireBytes(rendered, Number(cl), headers.some(([n, v]) => n.toLowerCase() === 'content-type' && v.toLowerCase().startsWith('multipart/form-data')))
    sections.push({ stepId: m[2], method: m[3], path: m[4], headers, body })
  }
  return sections
}

function parseDownstream(text: string): any[] {
  const sections: any[] = []
  for (const part of text.split(/^## /m).slice(1)) {
    const lines = part.split('\n')
    const m = /^((?:STEP \d+)|(?:AUX-\d+)) — (\S+) (\S+)$/.exec(lines[0].trim())
    if (!m) continue
    const statusBlock = STATUS_BLOCK_RE.exec(part)?.[1] ?? ''
    const statusLines = statusBlock.split('\n')
    const headers: Array<[string, string]> = []
    for (const line of statusLines.slice(1)) {
      const sep = line.indexOf(': ')
      headers.push([line.slice(0, sep), line.slice(sep + 2)])
    }
    const rendered = BODY_BLOCK_RE.exec(part)?.[1] ?? ''
    const cl = headers.find(([n]) => n.toLowerCase() === 'content-length')?.[1]
    const body = cl === undefined ? rendered : reconstructWireBytes(rendered, Number(cl), false)
    sections.push({ stepId: m[1], status: Number(statusLines[0].split(' ')[1]), headers, body })
  }
  return sections
}

async function seed(): Promise<string> {
  const d = parseDownstream(await readFile(new URL('S5-config-yaml/downstream.md', S5_ROOT), 'utf8'))
  return d[0].body
}

export async function runCase(caseId: string, log = true): Promise<void> {
  const reqs = parseRequestHttp(await readFile(new URL(`${caseId}/request.http`, S5_ROOT), 'utf8'))
  const downs = parseDownstream(await readFile(new URL(`${caseId}/downstream.md`, S5_ROOT), 'utf8'))
  const api = createManagementApi({
    configYaml: await seed(),
    managementKey: 'oracle-mgmt-key-1',
    store: new MemoryStore(),
    buildInfo: { version: 'v7.3.4', commit: '8335eac', buildDate: '2026-09-15T14:07:06Z', supportPlugin: true },
    clientIp: '127.0.0.1',
  })
  for (let i = 0; i < reqs.length; i += 1) {
    const req = reqs[i]
    const headers: Array<[string, string]> = []
    for (const [n, v] of req.headers) {
      if (n.toLowerCase() === 'host' || n.toLowerCase() === 'content-length') continue
      headers.push([n, v])
    }
    const response = await api.handle(new Request(`http://127.0.0.1:8407${req.path}`, {
      method: req.method,
      headers,
      body: req.body === '' ? undefined : req.body,
    }))
    const body = await response.text()
    const expected = downs[i]
    if (response.status !== expected.status || body !== expected.body) {
      if (log) {
        console.log(`STEP ${i + 1} ${req.method} ${req.path}`)
        console.log('  status', response.status, 'vs', expected.status)
        // first diff
        let at = 0
        while (at < Math.min(body.length, expected.body.length) && body[at] === expected.body[at]) at += 1
        console.log('  first diff at', at)
        console.log('  expected ...', JSON.stringify(expected.body.slice(Math.max(0, at - 40), at + 120)))
        console.log('  actual   ...', JSON.stringify(body.slice(Math.max(0, at - 40), at + 120)))
      }
      throw new Error(`${caseId} step ${i + 1} mismatch`)
    }
  }
}

describe('scratch replay', () => {
  it('replays a case', async () => {
    const target = process.env.S5_CASE ?? 'S5-config-get'
    await runCase(target)
  })
})

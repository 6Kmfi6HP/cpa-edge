
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { reEncodePrivateKey, normalizePrivateKeyPem } from './vertex'

describe('vertex pem', () => {
  it('re-encodes the fixture PKCS#8 key', async () => {
    const text = await readFile(new URL('../../../tests/fixtures/S5/S5-vertex-import/request.http', import.meta.url), 'utf8')
    const m = /"private_key": "((?:[^"\\]|\\.)*)"/.exec(text)
    expect(m).not.toBeNull()
    const pem = (m?.[1] ?? '').replaceAll('\\n', '\n')
    console.log('pem head:', JSON.stringify(pem.slice(0, 50)))
    console.log('pem tail:', JSON.stringify(pem.slice(-40)))
    const { der, kind } = normalizePrivateKeyPem(pem)
    console.log('kind', kind, 'der len', der.length)
    const out = reEncodePrivateKey(pem)
    console.log('re-encoded len', out.length)
    expect(out.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
  })
})

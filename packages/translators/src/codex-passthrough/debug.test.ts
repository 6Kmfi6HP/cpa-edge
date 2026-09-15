
import { test } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { readCase } from './fixture-reader'
import { createCodexPassthroughService } from './service'

test('diff bodies 04/05/06 again', async () => {
  for (const id of ['S2d9-04', 'S2d9-05', 'S2d9-06']) {
    const c = readCase(id)
    const svc = createCodexPassthroughService({
      apiKeys: c.config.apiKeys,
      credentials: c.config.credentials,
      store: new MemoryStore(),
      now: () => 1789506658255,
    })
    let captured = ''
    await svc.handleResponses(
      { method: c.request.method, path: c.request.path, headers: Object.entries(c.request.headers), body: c.request.body },
      async (req) => {
        captured = req.body
        return { status: 200, headers: [], body: new Response('x').body as ReadableStream<Uint8Array> }
      },
    )
    const recd = c.upstream[0]?.body ?? ''
    const mask = (b: string) => b.replace(/("prompt_cache_key":")[^"]*(")/g, '$1<SESSION>$2')
    const mine = mask(captured)
    const recdMasked = mask(recd)
    if (mine === recdMasked) { console.log(id + ': BODIES MATCH'); continue }
    for (let i = 0; i < Math.max(mine.length, recdMasked.length); i++) {
      if (mine[i] !== recdMasked[i]) {
        console.log(id + ' DIFF at ' + i)
        console.log('  mine: ' + JSON.stringify(mine.slice(Math.max(0, i - 60), i + 60)))
        console.log('  recd: ' + JSON.stringify(recdMasked.slice(Math.max(0, i - 60), i + 60)))
        break
      }
    }
  }
})

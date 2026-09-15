
import { it } from 'vitest'
import { createManagementApi } from '@cpa-edge/management'
import { createInMemoryKvStore } from './kv-store'
import { emitBlockYaml } from './config'

it('debug: facade direct', async () => {
  const record: Record<string, unknown> = {
    port: 18317,
    'remote-management': { 'allow-remote': true, 'secret-key': 'mgmt', 'disable-control-panel': true },
    'claude-api-key': [{ 'api-key': 'x', 'base-url': 'http://127.0.0.1:1', models: [{ name: 'm' }] }],
  }
  const api = createManagementApi({
    configYaml: emitBlockYaml(record),
    managementKey: 'mgmt',
    store: createInMemoryKvStore(),
    buildInfo: { version: 'v', commit: 'c', buildDate: 'd', supportPlugin: false },
  })
  const noKey = await api.handle(new Request('http://x/v0/management/anthropic-auth-url'))
  console.log('NOKEY', noKey.status, await noKey.clone().text().then(t => t.slice(0, 120)))
  const models = await api.handle(new Request('http://x/v0/management/logging-to-file'))
  console.log('SCALAR', models.status, await models.clone().text().then(t => t.slice(0, 120)))
})

/**
 * The Workers entry point: every request is forwarded to the singleton
 * Durable Object, which owns the gateway, the Store, the alarm pass and
 * the WebSocket sessions. TLS, routing and HTTP framing are terminated
 * by the platform edge (S7 F7: the `tls` config block is a no-op here).
 */
import { CpaEdgeDurableObject } from './durable-object'
import type { CloudflareEnv } from './types'

export { CpaEdgeDurableObject }

/** Singleton object name: one gateway state per Worker deployment. */
const SINGLETON_DO_NAME = 'default'

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const namespace = env.CPA_EDGE_DO
    if (namespace === undefined) {
      return new Response('cpa-edge: the CPA_EDGE_DO durable object binding is missing', {
        status: 500,
      })
    }
    const id = namespace.idFromName(SINGLETON_DO_NAME)
    return namespace.get(id).fetch(request)
  },
} satisfies ExportedHandler<CloudflareEnv>

/**
 * node:http adapter: sockets in, gateway requests out; gateway
 * responses onto the wire. All Node-specific code of the runtime lives
 * here and in this package alone.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { NodeGateway } from './gateway'
import { withCors } from './cors'
import { openAiError } from './envelopes'
import type { GatewayRequest, GatewayResponse, HeaderList } from './types'

/** Options for binding the gateway to a TCP socket. */
export interface ListenOptions {
  /** Bind host; defaults to loopback for safety (config `host` is the caller's choice). */
  readonly host?: string
  /** Bind port; 0 picks an ephemeral port. */
  readonly port?: number
}

/** A bound gateway server. */
export interface GatewayServer {
  readonly server: Server
  /** The resolved port (ephemeral ports included). */
  readonly port: number
  close(): Promise<void>
}

/** Go-style MIME canonicalization: `x-cpa-trace-id` -> `X-Cpa-Trace-Id`. */
function canonicalHeaderName(name: string): string {
  return name
    .split('-')
    .map((part) => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}

/** Headers the node server manages itself. */
const SERVER_MANAGED = new Set(['connection', 'transfer-encoding', 'date'])

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function toGatewayRequest(request: IncomingMessage, body: Uint8Array): GatewayRequest {
  const host = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1'
  const target = request.url ?? '/'
  const headers: Array<[string, string]> = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]
    const value = request.rawHeaders[index + 1]
    if (name === undefined || value === undefined) continue
    headers.push([name, value])
  }
  return {
    method: request.method ?? 'GET',
    url: `http://${host}${target}`,
    headers,
    body,
    ...(request.socket.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
  }
}

async function writeGatewayResponse(
  response: ServerResponse,
  gatewayResponse: GatewayResponse,
  requestMethod: string,
): Promise<void> {
  response.statusCode = gatewayResponse.status
  let body = gatewayResponse.body
  if (typeof body === 'string' && requestMethod === 'HEAD') {
    // HEAD responses carry the headers only.
    body = ''
  }
  for (const [rawName, value] of gatewayResponse.headers) {
    const name = canonicalHeaderName(rawName)
    if (SERVER_MANAGED.has(name.toLowerCase())) continue
    response.setHeader(name, value)
  }
  if (typeof body === 'string') {
    if (gatewayResponse.status !== 204 && gatewayResponse.status !== 304) {
      response.setHeader('Content-Length', String(Buffer.byteLength(body)))
    }
    response.end(body)
    return
  }
  if (gatewayResponse.status !== 204 && gatewayResponse.status !== 304) {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        if (!response.write(value)) {
          await once(response, 'drain')
        }
      }
      response.end()
    } catch (error) {
      // Mid-stream socket failure (client gone / write error): the
      // response cannot be completed, so drop the connection. The
      // facade-owned stream is released below; upstream teardown is the
      // facade's cancel() concern, not ours.
      console.error('[gateway] response stream failed', error)
      response.destroy()
    } finally {
      reader.releaseLock()
    }
    return
  }
  response.end()
}

/** Internal-error fallback body (gateway bug; never an upstream shape). */
const INTERNAL_ERROR_BODY = openAiError('internal gateway error', 'server_error', 'internal_server_error')

/** Binds the gateway to a TCP socket and serves until closed. */
export function listenGateway(gateway: NodeGateway, options: ListenOptions = {}): Promise<GatewayServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleConnection(gateway, request, response)
    })
    server.on('error', (error) => {
      reject(error)
    })
    const host = options.host ?? '127.0.0.1'
    server.listen(options.port ?? 0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0)
      resolve({
        server,
        port,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => {
              resolveClose()
            })
          }),
      })
    })
  })
}

async function handleConnection(
  gateway: NodeGateway,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let gatewayResponse: GatewayResponse
  try {
    const body = await readRequestBody(request)
    gatewayResponse = await gateway.handle(toGatewayRequest(request, body))
  } catch (error) {
    console.error('[gateway] request handling failed', error)
    gatewayResponse = {
      status: 500,
      headers: withCors([['Content-Type', 'application/json']]),
      body: INTERNAL_ERROR_BODY,
    }
  }
  await writeGatewayResponse(response, gatewayResponse, request.method ?? 'GET')
}

/** Type re-export so adapters can name the wire header list. */
export type { HeaderList }

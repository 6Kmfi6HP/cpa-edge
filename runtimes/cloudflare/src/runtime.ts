/**
 * The Durable Object runtime (mission T2): one object instance is this
 * platform's "process". It owns
 *
 * - the DO-backed Store every package facade is wired to (R1),
 * - the composed gateway over the merged facades (R2),
 * - config bootstrap and persistence: the config.yaml text resolves
 *   from the object's own stored copy first, then a KV binding, then a
 *   plain-text binding (R5); management mutations are written back to
 *   the store and hot-reload the composite (F6: management-writes-only),
 * - the alarm pass (R3), armed from boot and re-armed by every pass,
 * - live WebSocket hibernation sessions (S7 F4) and their termination
 *   when a config edit enables `ws-auth` (OQ-S7-05 - the close code is
 *   this runtime's owned choice: 1008 policy violation).
 *
 * The Workers entry is a thin proxy: every request is forwarded to the
 * singleton object, so every request sees one strongly consistent
 * state.
 */
import type { FetchLike } from '@cpa-edge/auth'
import { CONFIG_NAMESPACE, CONFIG_TEXT_KEY, resolveConfigText, type RuntimeConfigInput } from './config'
import { createDurableObjectStore, type DurableObjectStore } from './do-store'
import { createCloudflareGateway, type CloudflareGateway } from './gateway'
import { IDLE_HEARTBEAT_MS, ensureAlarmBefore, runAlarmPass } from './alarm'
import { openAiError } from './envelopes'
import { withCors } from './cors'
import { parseConfigText } from './yaml-config'
import type {
  DoAlarmLike,
  DoStorageLike,
  GatewayRequest,
  GatewayResponse,
  RuntimeEnvSources,
  WebSocketHost,
} from './types'

/** Constructor options of the runtime. */
export interface DurableObjectRuntimeOptions {
  readonly storage: DoStorageLike
  readonly alarm: DoAlarmLike
  /** WebSocket hibernation host; absent only in non-DO compositions. */
  readonly sockets?: WebSocketHost
  /** Config bootstrap sources (KV binding / plain-text binding). */
  readonly env: RuntimeEnvSources
  /** Epoch-milliseconds clock; defaults to Date.now. */
  readonly now?: () => number
  /** Upstream transport; defaults to the platform fetch. */
  readonly fetch?: FetchLike
  /** Config-text parser override (tests). */
  readonly parseConfigText?: (text: string) => RuntimeConfigInput
}

/** KV key the config loader reads from the `CPA_CONFIG` binding. */
const CONFIG_KV_KEY = 'config.yaml'

/** Close code for sessions terminated by a ws-auth flip (owned choice). */
const WS_AUTH_CLOSE_CODE = 1008
const WS_AUTH_CLOSE_REASON = 'websocket auth required'

/**
 * The runtime state machine. `fetch` and `alarm` may be invoked
 * concurrently by the platform; boot is single-flight and every state
 * mutation after it flows through the recompose path.
 */
export class DurableObjectRuntime {
  private readonly store: DurableObjectStore
  private readonly alarmSurface: DoAlarmLike
  private readonly sockets: WebSocketHost | undefined
  private readonly env: RuntimeEnvSources
  private readonly now: () => number
  private readonly fetchLike: FetchLike
  private readonly parse: (text: string) => RuntimeConfigInput

  private gateway: CloudflareGateway | undefined
  private configText: string | undefined
  private bootPromise: Promise<void> | undefined

  constructor(options: DurableObjectRuntimeOptions) {
    this.store = createDurableObjectStore(options.storage, {
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.alarmSurface = options.alarm
    this.sockets = options.sockets
    this.env = options.env
    this.now = options.now ?? (() => Date.now())
    this.fetchLike = options.fetch ?? ((input, init) => fetch(input, init))
    this.parse = options.parseConfigText ?? parseConfigText
  }

  /** The store shared by every facade (exposed for tests). */
  getStore(): DurableObjectStore {
    return this.store
  }

  /** Entry point for HTTP traffic forwarded by the Workers entry. */
  async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureBoot()
      const gatewayRequest = await this.toGatewayRequest(request)
      const gateway = this.currentGateway()
      const response = await gateway.handle(gatewayRequest)
      const pathname = new URL(request.url).pathname
      if (pathname === '/v0/management' || pathname.startsWith('/v0/management/')) {
        await this.persistConfigAfterManagement()
      }
      return this.fromGatewayResponse(response, request.method)
    } catch (error) {
      console.error('[cloudflare-runtime] request handling failed', error)
      return new Response(openAiError('internal gateway error', 'server_error', 'internal_server_error'), {
        status: 500,
        headers: new Headers(Object.fromEntries(withCors([['Content-Type', 'application/json']]))),
      })
    }
  }

  /** The scheduled pass: refresh, device polls, sweeps, re-arm (R3). */
  async alarm(): Promise<void> {
    await this.ensureBoot()
    const gateway = this.currentGateway()
    try {
      await runAlarmPass({
        store: this.store,
        now: this.now,
        fetch: this.fetchLike,
        config: () => gateway.config,
        alarm: this.alarmSurface,
      })
    } catch (error) {
      // Durability across passes: a failed pass must never kill the
      // loop (a fresh alarm is only set at the END of a pass, so
      // re-throwing here would leave the object unscheduled until some
      // request happens to poke it - possibly never, since the DO can
      // hibernate indefinitely). Log, re-arm the heartbeat, and let the
      // next pass retry the work.
      console.error('[cloudflare-runtime] alarm pass failed; re-arming heartbeat', error)
      await ensureAlarmBefore(this.alarmSurface, this.now() + IDLE_HEARTBEAT_MS)
    }
  }

  // ---- boot ---------------------------------------------------------------

  private async ensureBoot(): Promise<void> {
    if (this.bootPromise === undefined) {
      this.bootPromise = this.boot()
    }
    await this.bootPromise
  }

  private async boot(): Promise<void> {
    const resolved = await resolveConfigText({
      stored: async () => {
        const stored = await this.store.get(CONFIG_NAMESPACE, CONFIG_TEXT_KEY)
        return typeof stored === 'string' ? stored : undefined
      },
      kv: this.env.configKv,
      bindingText: this.env.configText,
      kvKey: CONFIG_KV_KEY,
    })
    if (resolved.source !== 'stored') {
      // Bootstrap sources seed the stored copy once; after that the
      // store IS the config (management writes are the only mutation
      // path - S7 F6).
      await this.store.put(CONFIG_NAMESPACE, CONFIG_TEXT_KEY, resolved.text)
    }
    await this.recompose(resolved.text)
    await ensureAlarmBefore(this.alarmSurface, this.now() + IDLE_HEARTBEAT_MS)
  }

  private currentGateway(): CloudflareGateway {
    if (this.gateway === undefined) throw new Error('runtime booted without a gateway')
    return this.gateway
  }

  // ---- config persistence + hot reload --------------------------------------

  /**
   * After a management request: persist the facade's current config
   * text when it moved, then hot-reload the whole composite (the
   * serverless equivalent of the file watcher: writes apply
   * immediately, F6-1).
   */
  private async persistConfigAfterManagement(): Promise<void> {
    const gateway = this.currentGateway()
    const facade = gateway.managementApi
    if (facade === undefined) return
    const text = await facade.readConfigFile()
    if (text === this.configText) return
    await this.store.put(CONFIG_NAMESPACE, CONFIG_TEXT_KEY, text)
    await this.recompose(text)
  }

  private async recompose(configText: string): Promise<void> {
    const previous = this.gateway
    const configInput = this.parse(configText)
    const gateway = createCloudflareGateway({
      config: configInput,
      configYaml: configText.length > 0 ? configText : undefined,
      store: this.store,
      now: this.now,
      fetch: this.fetchLike,
      ...(this.sockets === undefined ? {} : { sockets: this.sockets }),
      alarm: this.alarmSurface,
    })
    this.configText = configText
    this.gateway = gateway
    if (previous !== undefined) {
      const wasOpen = !previous.config.wsAuth
      const nowGated = gateway.config.wsAuth
      if (wasOpen && nowGated) {
        // Enabling ws-auth terminates live sessions abnormally
        // (S7 section 2.1 F4; close code owned per OQ-S7-05).
        this.terminateWsSessions()
      }
    }
  }

  private terminateWsSessions(): void {
    if (this.sockets === undefined) return
    for (const socket of this.sockets.list('ws-relay')) {
      try {
        socket.close(WS_AUTH_CLOSE_CODE, WS_AUTH_CLOSE_REASON)
      } catch {
        // A socket that already closed needs no termination.
      }
    }
  }

  // ---- wire conversion -------------------------------------------------------

  private async toGatewayRequest(request: Request): Promise<GatewayRequest> {
    const body = new Uint8Array(await request.arrayBuffer())
    const headers: Array<[string, string]> = []
    request.headers.forEach((value, name) => {
      headers.push([name, value])
    })
    const remoteAddress = request.headers.get('cf-connecting-ip') ?? undefined
    return {
      method: request.method,
      url: request.url,
      headers,
      body,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    }
  }

  private fromGatewayResponse(response: GatewayResponse, requestMethod: string): Response {
    if (response.webSocket !== undefined) {
      return new Response(null, { status: 101, webSocket: response.webSocket })
    }
    const headerRecord: Record<string, string> = {}
    for (const [name, value] of response.headers) headerRecord[name] = value
    const head = requestMethod === 'HEAD'
    if (head || response.status === 204 || response.status === 304) {
      return new Response(null, { status: response.status, headers: headerRecord })
    }
    return new Response(response.body, { status: response.status, headers: headerRecord })
  }
}

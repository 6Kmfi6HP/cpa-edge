/**
 * Platform capability descriptor consumed by the router at construction time.
 *
 * The shape is owned by the core package so every layer can type against it;
 * the VALUES are runtime facts. `runtimes/*` re-export their constant as the
 * single source of truth for that platform, and contract tests construct a
 * node server with a modified descriptor (for example the vercel values) to
 * exercise degraded paths. The descriptor is immutable for the process
 * lifetime and is always passed in - never read from a module-level
 * singleton.
 */
export interface RuntimeCapabilities {
  /** GET /v1/ws upgrade + relay sessions. */
  readonly inboundWebSocket: boolean
  /** Outbound proxy-url dialing (socks5/socks5h/http/https). */
  readonly proxyTransport: boolean
  /** C-ABI dynamic library loading. MUST be false in every CPA-Edge runtime. */
  readonly pluginLoading: boolean
  /** Persistent rotating logs behind /v0/management/logs. */
  readonly fileLogging: boolean
  /** External config/auth file watching (hot reload of outside edits). */
  readonly fileWatching: boolean
  /** Binding extra localhost ports for OAuth redirect forwarders. */
  readonly localCallbackServer: boolean
}

/**
 * Full-capability profile declared by runtimes/node: the reference runtime
 * for contract tests. Every capability the core knows about is on, except
 * plugin loading, which is absent project-wide by design.
 */
export const NODE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  inboundWebSocket: true,
  proxyTransport: true,
  pluginLoading: false,
  fileLogging: true,
  fileWatching: true,
  localCallbackServer: true,
})

/**
 * Profile for the cloudflare runtime: raw-socket egress and filesystem
 * watching do not exist; upgradeable WebSockets and DO-backed log storage do.
 */
export const CLOUDFLARE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  inboundWebSocket: true,
  proxyTransport: false,
  pluginLoading: false,
  fileLogging: true,
  fileWatching: false,
  localCallbackServer: false,
})

/**
 * Profile for the vercel runtime: the most constrained platform - no inbound
 * WebSocket upgrades, no proxy egress, no log files, no filesystem watching,
 * no callback port binding.
 */
export const VERCEL_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  inboundWebSocket: false,
  proxyTransport: false,
  pluginLoading: false,
  fileLogging: false,
  fileWatching: false,
  localCallbackServer: false,
})

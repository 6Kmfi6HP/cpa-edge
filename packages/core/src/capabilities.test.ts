import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_RUNTIME_CAPABILITIES,
  NODE_RUNTIME_CAPABILITIES,
  VERCEL_RUNTIME_CAPABILITIES,
} from './capabilities'
import type { RuntimeCapabilities } from './capabilities'

describe('runtime capability descriptors (S7 3.1)', () => {
  it('declares the node profile with REGISTERED-ABSENT capabilities disabled per GR-5', () => {
    expect(NODE_RUNTIME_CAPABILITIES).toEqual({
      inboundWebSocket: true,
      proxyTransport: false,
      pluginLoading: false,
      fileLogging: false,
      fileWatching: false,
      localCallbackServer: false,
    } satisfies RuntimeCapabilities)
  })

  it('declares the cloudflare profile without raw sockets or files', () => {
    expect(CLOUDFLARE_RUNTIME_CAPABILITIES).toEqual({
      inboundWebSocket: true,
      proxyTransport: false,
      pluginLoading: false,
      fileLogging: true,
      fileWatching: false,
      localCallbackServer: false,
    } satisfies RuntimeCapabilities)
  })

  it('declares the vercel profile as the most constrained', () => {
    expect(VERCEL_RUNTIME_CAPABILITIES).toEqual({
      inboundWebSocket: false,
      proxyTransport: false,
      pluginLoading: false,
      fileLogging: false,
      fileWatching: false,
      localCallbackServer: false,
    } satisfies RuntimeCapabilities)
  })

  it('freezes every descriptor: plugin loading is absent project-wide', () => {
    expect(Object.isFrozen(NODE_RUNTIME_CAPABILITIES)).toBe(true)
    expect(Object.isFrozen(CLOUDFLARE_RUNTIME_CAPABILITIES)).toBe(true)
    expect(Object.isFrozen(VERCEL_RUNTIME_CAPABILITIES)).toBe(true)
    expect(NODE_RUNTIME_CAPABILITIES.pluginLoading).toBe(false)
    expect(CLOUDFLARE_RUNTIME_CAPABILITIES.pluginLoading).toBe(false)
    expect(VERCEL_RUNTIME_CAPABILITIES.pluginLoading).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { createAuthPlane } from './plane'

/**
 * Plane-level regressions for the composed auth surface. The golden
 * contract (tests/contract/s3-auth.test.ts) drives the plane with the
 * construction-time remote address only; these cases pin the per-request
 * remoteAddress override the node runtime needs for XFF-derived socket
 * addresses.
 */

const SECRET = 'oracle-mgmt-key-1'

function managementRequest(key: string): Request {
  return new Request('http://127.0.0.1:8387/v0/management/api-keys', {
    headers: { 'x-management-key': key },
  })
}

describe('management middleware remoteAddress override', () => {
  it('drives the remote gate per request through one plane instance', async () => {
    const plane = createAuthPlane(
      {
        port: 8387,
        apiKeys: [],
        remoteManagement: { allowRemote: false, secretKey: SECRET },
      },
      { remoteAddress: '127.0.0.1' },
    )
    expect(plane.managementAvailable()).toBe(true)

    // Loopback override: a valid key passes the remote gate.
    const local = await plane.authenticateManagement(managementRequest(SECRET), {
      remoteAddress: '127.0.0.1',
    })
    expect(local.ok).toBe(true)
    if (local.ok) {
      expect(local.headers.map(([name]) => name)).toContain('X-Cpa-Version')
    }

    // Same request through the same plane, remote override: gated.
    const remote = await plane.authenticateManagement(managementRequest(SECRET), {
      remoteAddress: '203.0.113.7',
    })
    expect(remote.ok).toBe(false)
    if (!remote.ok) {
      expect(remote.response.status).toBe(403)
      expect(await remote.response.text()).toBe('{"error":"remote management disabled"}')
      expect(remote.response.headers.get('X-Cpa-Version')).toBe('v7.3.4')
    }

    // No override: falls back to the construction-time address (loopback).
    const fallback = await plane.authenticateManagement(managementRequest(SECRET))
    expect(fallback.ok).toBe(true)

    // A remote fallback address is gated the same way, proving the
    // construction-time dep still applies when no override is given.
    const remotePlane = createAuthPlane(
      {
        port: 8387,
        apiKeys: [],
        remoteManagement: { allowRemote: false, secretKey: SECRET },
      },
      { remoteAddress: '203.0.113.7' },
    )
    const gated = await remotePlane.authenticateManagement(managementRequest(SECRET))
    expect(gated.ok).toBe(false)
    if (!gated.ok) expect(gated.response.status).toBe(403)
  })

  it('counts the resolved per-request address, so a spoofed loopback XFF override still passes', async () => {
    // XFF resolution is trust-all by design (recorded reality): the
    // override only feeds the TCP-side fallback, while the header list
    // still decides the client IP when it parses.
    const plane = createAuthPlane(
      {
        port: 8387,
        apiKeys: [],
        remoteManagement: { allowRemote: false, secretKey: SECRET },
      },
      { remoteAddress: '203.0.113.7' },
    )
    const request = new Request('http://127.0.0.1:8387/v0/management/api-keys', {
      headers: { 'x-management-key': SECRET, 'x-forwarded-for': '127.0.0.1' },
    })
    const verdict = await plane.authenticateManagement(request, {
      remoteAddress: '203.0.113.7',
    })
    expect(verdict.ok).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { OAuthSessionRegistry } from './oauth-sessions'
import {
  OAuthCallbackService,
  OAUTH_SUCCESS_HTML,
  storePublishCallback,
  type PublishCallbackFn,
} from './oauth-callback'

function fixture(publish?: PublishCallbackFn) {
  const store = new MemoryStore()
  const registry = new OAuthSessionRegistry(store, { now: () => 1_000_000 })
  const service = new OAuthCallbackService(registry, {
    publish: publish ?? storePublishCallback(store),
  })
  return { store, registry, service }
}

const STATE = '0123456789abcdef0123456789abcdef'

describe('plain callback routes (§2.4)', () => {
  it('always answers 200 success HTML, even for an unknown state', async () => {
    const { service } = fixture()
    const decision = await service.handlePlainCallback('anthropic', {
      code: 'fake-code',
      state: STATE,
    })
    expect(decision).toEqual({ status: 200, body: OAUTH_SUCCESS_HTML })
  })

  it('ignores callback write failures and still answers 200', async () => {
    const failing: PublishCallbackFn = async () => {
      throw new Error('read-only auth dir')
    }
    const { service, registry } = fixture(failing)
    await registry.register(STATE, 'anthropic')
    const decision = await service.handlePlainCallback('anthropic', {
      code: 'c',
      state: STATE,
    })
    expect(decision.status).toBe(200)
  })

  it('uses error_description as the error fallback', async () => {
    const { service } = fixture()
    const decision = await service.handlePlainCallback('codex', {
      error: 'access_denied',
      errorDescription: 'user denied',
      state: STATE,
    })
    expect(decision.status).toBe(200)
  })
})

describe('strict devin callback routes (§2.4)', () => {
  it('requires code or error', async () => {
    const { service } = fixture()
    const decision = await service.handleStrictCallback({})
    expect(decision).toEqual({
      status: 400,
      body: '{"error":"code or error is required"}',
      headers: { 'Cache-Control': 'no-store' },
    })
  })

  it('rejects a code with no matching pending session', async () => {
    const { service } = fixture()
    const decision = await service.handleStrictCallback({ code: 'fake-code', state: STATE })
    expect(decision).toEqual({
      status: 400,
      body: '{"error":"invalid or expired OAuth callback"}',
      headers: { 'Cache-Control': 'no-store' },
    })
  })

  it('persists for a pending devin session and answers 200 HTML', async () => {
    const { service, registry, store } = fixture()
    await registry.register(STATE, 'devin')
    const decision = await service.handleStrictCallback({ code: 'c', state: STATE })
    expect(decision.status).toBe(200)
    expect(decision.body).toBe(OAUTH_SUCCESS_HTML)
    const published = await store.list('oauth-callbacks')
    expect(published).toEqual([`.oauth-devin-${STATE}.oauth`])
  })

  it('propagates a failing publish as the 500 persist body', async () => {
    const failing: PublishCallbackFn = async () => {
      throw new Error('read-only auth dir')
    }
    const { service, registry } = fixture(failing)
    await registry.register(STATE, 'devin')
    const decision = await service.handleStrictCallback({ code: 'c', state: STATE })
    expect(decision).toEqual({
      status: 500,
      body: '{"error":"failed to persist oauth callback"}',
      headers: { 'Cache-Control': 'no-store' },
    })
  })
})

describe('management oauth-callback ladder (§2.4)', () => {
  it('rejects an unparseable or non-object POST body first', async () => {
    const { service } = fixture()
    expect(await service.handleManagementCallbackPost(undefined)).toEqual({
      status: 400,
      body: '{"error":"invalid body","status":"error"}',
    })
    expect(await service.handleManagementCallbackPost('just-a-string')).toEqual({
      status: 400,
      body: '{"error":"invalid body","status":"error"}',
    })
    expect(await service.handleManagementCallbackPost([1, 2])).toEqual({
      status: 400,
      body: '{"error":"invalid body","status":"error"}',
    })
  })

  it('checks redirect_url before state handling', async () => {
    const { service } = fixture()
    const decision = await service.handleManagementCallbackPost({
      redirect_url: 'http://%zz',
      state: STATE,
      code: 'x',
    })
    expect(decision).toEqual({
      status: 400,
      body: '{"error":"invalid redirect_url","status":"error"}',
    })
  })

  it('uses a parseable redirect_url query as the fallback source', async () => {
    const { service, registry } = fixture()
    await registry.register(STATE, 'anthropic')
    // Neither state nor code in the body: both come from the redirect query.
    const decision = await service.handleManagementCallbackPost({
      redirect_url: `https://claude.ai/cb?state=${STATE}&code=redirect-code`,
    })
    expect(decision).toEqual({ status: 200, body: '{"status":"ok"}' })
    // Body fields win over the redirect query.
    const overridden = await service.handleManagementCallbackPost({
      redirect_url: 'https://claude.ai/cb?state=other&code=other-code',
      state: STATE,
      code: 'x',
    })
    expect(overridden).toEqual({ status: 200, body: '{"status":"ok"}' })
  })

  it('walks the ladder in the recorded order', async () => {
    const { service } = fixture()
    expect(await service.handleManagementCallbackPost({ code: 'x' })).toEqual({
      status: 400,
      body: '{"error":"state is required","status":"error"}',
    })
    expect(
      await service.handleManagementCallbackPost({ state: 'bad state!', code: 'x' }),
    ).toEqual({ status: 400, body: '{"error":"invalid state","status":"error"}' })
    expect(
      await service.handleManagementCallbackGet({ provider: 'anthropic', state: STATE }),
    ).toEqual({ status: 400, body: '{"error":"code or error is required","status":"error"}' })
    expect(
      await service.handleManagementCallbackPost({ provider: 'anthropic', state: STATE, code: 'x' }),
    ).toEqual({ status: 404, body: '{"error":"unknown or expired state","status":"error"}' })
  })

  it('defaults the provider to the session provider before normalization', async () => {
    const { service, registry, store } = fixture()
    await registry.register(STATE, 'anthropic')
    const decision = await service.handleManagementCallbackPost({ state: STATE, code: 'c' })
    expect(decision).toEqual({ status: 200, body: '{"status":"ok"}' })
    expect(await store.list('oauth-callbacks')).toEqual([`.oauth-anthropic-${STATE}.oauth`])
  })

  it('normalizes documented aliases and rejects unknown providers', async () => {
    const { service, registry } = fixture()
    await registry.register(STATE, 'anthropic')
    expect(
      await service.handleManagementCallbackPost({ provider: 'claude', state: STATE, code: 'c' }),
    ).toEqual({ status: 200, body: '{"status":"ok"}' })
    await registry.register('state-2', 'codex')
    expect(
      await service.handleManagementCallbackPost({ provider: '@@', state: 'state-2', code: 'c' }),
    ).toEqual({ status: 400, body: '{"error":"unsupported provider","status":"error"}' })
  })

  it('answers 400 provider mismatch when the session belongs to another provider', async () => {
    const { service, registry } = fixture()
    await registry.register(STATE, 'codex')
    const decision = await service.handleManagementCallbackPost({
      provider: 'anthropic',
      state: STATE,
      code: 'x',
    })
    expect(decision).toEqual({
      status: 400,
      body: '{"error":"provider does not match state","status":"error"}',
    })
  })

  it('answers 409 for completed and errored sessions', async () => {
    const { service, registry } = fixture()
    await registry.register('done-state', 'anthropic')
    await registry.complete('done-state')
    expect(
      await service.handleManagementCallbackPost({
        provider: 'anthropic',
        state: 'done-state',
        code: 'c',
      }),
    ).toEqual({
      status: 409,
      body: '{"error":"oauth flow is already completed","status":"error"}',
    })
    await registry.register('err-state', 'anthropic')
    await registry.setStatusError('err-state', 'Failed to exchange authorization code for tokens')
    expect(
      await service.handleManagementCallbackPost({
        provider: 'anthropic',
        state: 'err-state',
        code: 'c',
      }),
    ).toEqual({
      status: 409,
      body: '{"error":"Failed to exchange authorization code for tokens","status":"error"}',
    })
  })

  it('answers 500 failed to persist when the callback write fails', async () => {
    const failing: PublishCallbackFn = async () => {
      throw new Error('read-only auth dir')
    }
    const { service, registry } = fixture(failing)
    await registry.register(STATE, 'anthropic')
    const decision = await service.handleManagementCallbackPost({
      provider: 'anthropic',
      state: STATE,
      code: 'x',
    })
    expect(decision).toEqual({
      status: 500,
      body: '{"error":"failed to persist oauth callback","status":"error"}',
    })
  })

  it('matches the recorded success HTML byte-for-byte', () => {
    expect(OAUTH_SUCCESS_HTML).toBe(
      '<html><head><meta charset="utf-8"><title>Authentication successful</title><script>setTimeout(function(){window.close();},5000);</script></head><body><h1>Authentication successful!</h1><p>You can close this window.</p><p>This window will close automatically in 5 seconds.</p></body></html>',
    )
    expect(new TextEncoder().encode(OAUTH_SUCCESS_HTML).length).toBe(288)
  })
})

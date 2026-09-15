import { isJsonValue, type JsonValue, type Store } from '@cpa-edge/core'
import { normalizeProvider } from './providers'
import { isValidOauthState, OAUTH_SESSIONS_NAMESPACE, type OAuthSessionRegistry } from './oauth-sessions'
import type { AuthResponse } from './types'
import { goJsonStringify, parseGoUrl, parseQueryString } from './wire'

/**
 * OAuth callback surfaces of the main server port.
 *
 * Plain routes (`/anthropic/callback`, `/codex/callback`,
 * `/antigravity/callback`) always answer 200 with the fixed success HTML;
 * callback writes for a matching pending session are attempted when a
 * state is present, and write failures are ignored. The strict routes
 * (`/callback`, `/devin/callback`) validate first and answer 400 JSON on
 * failure. The management route runs the recorded 400/404/409/500 ladder
 * over the Store-backed session registry and publishes the callback
 * handshake document.
 */

/** Store namespace holding the callback handshake documents. */
export const OAUTH_CALLBACKS_NAMESPACE = 'oauth-callbacks'

/** Fixed success HTML of the callback routes (byte-pinned by goldens). */
export const OAUTH_SUCCESS_HTML =
  '<html><head><meta charset="utf-8"><title>Authentication successful</title><script>setTimeout(function(){window.close();},5000);</script></head><body><h1>Authentication successful!</h1><p>You can close this window.</p><p>This window will close automatically in 5 seconds.</p></body></html>'

/** Callback query parameters shared by every route. */
export interface CallbackParams {
  readonly code?: string
  readonly state?: string
  readonly error?: string
  readonly errorDescription?: string
  /** Management GET route only. */
  readonly provider?: string
}

function callbackFileKey(provider: string, state: string): string {
  return `.oauth-${provider}-${state}.oauth`
}

/** One published callback handshake document: `{code, state, error}`. */
export interface OAuthCallbackFile {
  readonly code: string
  readonly state: string
  readonly error: string
}

/** Writes the handshake document atomically through the Store. */
export async function publishCallbackFile(
  store: Store,
  provider: string,
  state: string,
  file: OAuthCallbackFile,
): Promise<void> {
  const doc: { readonly [key: string]: JsonValue } = {
    code: file.code,
    state: file.state,
    error: file.error,
  }
  await store.put(OAUTH_CALLBACKS_NAMESPACE, callbackFileKey(provider, state), doc)
}

/** Reads and consumes one handshake document, if published. */
export async function consumeCallbackFile(
  store: Store,
  provider: string,
  state: string,
): Promise<OAuthCallbackFile | undefined> {
  const key = callbackFileKey(provider, state)
  const raw = await store.get(OAUTH_CALLBACKS_NAMESPACE, key)
  if (raw === undefined) return undefined
  await store.delete(OAUTH_CALLBACKS_NAMESPACE, key)
  if (!isJsonValue(raw) || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as { [key: string]: JsonValue }
  const code = record['code']
  const state2 = record['state']
  const error = record['error']
  if (typeof code !== 'string' || typeof state2 !== 'string' || typeof error !== 'string') {
    return undefined
  }
  return { code, state: state2, error }
}

/** Extracts the effective params from a callback request. */
export function effectiveCallbackParams(params: CallbackParams): OAuthCallbackFile {
  const code = params.code ?? ''
  const state = params.state ?? ''
  const error = params.error ?? params.errorDescription ?? ''
  return { code, state, error }
}

/** Publisher seam for callback handshake records. */
export type PublishCallbackFn = (
  provider: string,
  state: string,
  file: OAuthCallbackFile,
) => Promise<void>

/** Store-backed publisher: runtimes bind waiters to the same Store. */
export function storePublishCallback(store: Store): PublishCallbackFn {
  return (provider, state, file) => publishCallbackFile(store, provider, state, file)
}

/** Service behind the plain and management callback routes. */
export class OAuthCallbackService {
  private readonly registry: OAuthSessionRegistry
  private readonly publish: PublishCallbackFn

  constructor(
    registry: OAuthSessionRegistry,
    options: { publish: PublishCallbackFn },
  ) {
    this.registry = registry
    this.publish = options.publish
  }

  /**
   * `GET /anthropic/callback`, `/codex/callback`, `/antigravity/callback`:
   * always 200 success HTML; a matching pending session gets a callback
   * write attempt whose failure is ignored.
   */
  async handlePlainCallback(
    provider: 'anthropic' | 'codex' | 'antigravity',
    params: CallbackParams,
  ): Promise<AuthResponse> {
    const file = effectiveCallbackParams(params)
    if (file.state.length > 0) {
      const session = await this.registry.get(file.state)
      if (session !== undefined && session.status === 'pending' && !session.completed) {
        try {
          await this.publish(session.provider, file.state, file)
        } catch {
          // Recorded reality: write failures are swallowed here.
        }
      }
    }
    return { status: 200, body: OAUTH_SUCCESS_HTML }
  }

  /**
   * `GET /callback` and `/devin/callback` (strict): `Cache-Control:
   * no-store` always; 400 when neither code nor error is present, 400 when
   * no matching pending session exists, otherwise the callback write and
   * the success HTML.
   */
  async handleStrictCallback(params: CallbackParams): Promise<AuthResponse> {
    const headers = { 'Cache-Control': 'no-store' }
    const file = effectiveCallbackParams(params)
    if (file.code.length === 0 && file.error.length === 0) {
      return {
        status: 400,
        body: goJsonStringify({ error: 'code or error is required' }),
        headers,
      }
    }
    const state = file.state
    const session =
      state.length > 0 && isValidOauthState(state) ? await this.registry.get(state) : undefined
    if (
      session === undefined ||
      session.completed ||
      session.status !== 'pending' ||
      session.provider !== 'devin'
    ) {
      return {
        status: 400,
        body: goJsonStringify({ error: 'invalid or expired OAuth callback' }),
        headers,
      }
    }
    try {
      await this.publish(session.provider, state, file)
    } catch {
      return {
        status: 500,
        body: goJsonStringify({ error: 'failed to persist oauth callback' }),
        headers,
      }
    }
    return { status: 200, body: OAUTH_SUCCESS_HTML, headers }
  }

  /**
   * `POST /v0/management/oauth-callback`. The caller hands over the parsed
   * JSON body (`undefined` marks an unparseable or non-object body).
   */
  async handleManagementCallbackPost(parsedBody: unknown): Promise<AuthResponse> {
    if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
      return errorBody(400, 'invalid body')
    }
    const record = parsedBody as Record<string, unknown>
    const redirectUrl = typeof record['redirect_url'] === 'string' ? record['redirect_url'] : ''
    let fallbackQuery: Record<string, string> = {}
    if (redirectUrl.length > 0) {
      const parsed = parseGoUrl(redirectUrl)
      if (parsed === undefined) return errorBody(400, 'invalid redirect_url')
      fallbackQuery = parsed.query.length > 0 ? parseQueryString(parsed.query) : {}
    }
    const code = typeof record['code'] === 'string' ? record['code'] : fallbackQuery['code'] ?? ''
    const error = typeof record['error'] === 'string' ? record['error'] : fallbackQuery['error'] ?? ''
    const provider = typeof record['provider'] === 'string' ? record['provider'] : undefined
    const state = typeof record['state'] === 'string' ? record['state'] : fallbackQuery['state'] ?? ''
    return this.evaluateManagementCallback({ provider, code, state, error })
  }

  /** `GET /v0/management/oauth-callback`. */
  async handleManagementCallbackGet(params: CallbackParams): Promise<AuthResponse> {
    return this.evaluateManagementCallback({
      provider: params.provider,
      code: params.code ?? '',
      state: params.state ?? '',
      error: params.error ?? params.errorDescription ?? '',
    })
  }

  private async evaluateManagementCallback(input: {
    provider: string | undefined
    code: string
    state: string
    error: string
  }): Promise<AuthResponse> {
    if (input.state.length === 0) return errorBody(400, 'state is required')
    if (!isValidOauthState(input.state)) return errorBody(400, 'invalid state')
    if (input.code.length === 0 && input.error.length === 0) {
      return errorBody(400, 'code or error is required')
    }
    const session = await this.registry.get(input.state)
    if (session === undefined) return errorBody(404, 'unknown or expired state')
    if (session.completed) return errorBody(409, 'oauth flow is already completed')
    // Provider omitted: defaults to the session's provider.
    const requestedProvider = input.provider ?? session.provider
    const normalized = normalizeProvider(requestedProvider)
    if (!normalized.ok) return errorBody(400, 'unsupported provider')
    if (session.status !== 'pending') {
      return errorBody(409, session.status)
    }
    if (normalized.provider !== session.provider) {
      return errorBody(400, 'provider does not match state')
    }
    // Persist with the pending-session guard: a session that changed state
    // between the read above and this write answers 409; a vanished one is
    // the cancel race.
    const guard = await this.registry.get(input.state)
    if (guard === undefined) return errorBody(409, 'oauth flow is not pending')
    if (guard.completed) return errorBody(409, 'oauth flow is already completed')
    if (guard.status !== 'pending') return errorBody(409, guard.status)
    if (normalized.provider !== guard.provider) {
      return errorBody(400, 'provider does not match state')
    }
    try {
      await this.publish(session.provider, input.state, {
        code: input.code,
        state: input.state,
        error: input.error,
      })
    } catch {
      return errorBody(500, 'failed to persist oauth callback')
    }
    return { status: 200, body: goJsonStringify({ status: 'ok' }) }
  }
}

function errorBody(status: 400 | 404 | 409 | 500, message: string): AuthResponse {
  return { status, body: goJsonStringify({ error: message, status: 'error' }) }
}

export { OAUTH_SESSIONS_NAMESPACE }

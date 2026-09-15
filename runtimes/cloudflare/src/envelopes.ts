/**
 * Route-owned wire bodies: the envelopes the Workers gateway itself
 * emits before any translator facade is involved (S1 section 6) plus the
 * platform-degradation bodies of S7 section 3.2. Byte-exact strings; key
 * order mirrors the recorded serialization. Direction-owned envelopes
 * stay in the packages.
 */
import type { GatewayResponse, HeaderList } from './types'

export const JSON_CHARSET = 'application/json; charset=utf-8'
export const JSON_PLAIN = 'application/json'
export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

/** Builds a gateway response with explicit header pairs. */
export function jsonResponse(status: number, body: string, headers: HeaderList = []): GatewayResponse {
  return { status, headers, body }
}

/** JSON response with `Content-Type: application/json` (no charset). */
export function plainJson(status: number, body: string, headers: HeaderList = []): GatewayResponse {
  return jsonResponse(status, body, [['Content-Type', JSON_PLAIN], ...headers])
}

/** JSON response with the charset form (auth- and stub-family bodies). */
export function charsetJson(status: number, body: string, headers: HeaderList = []): GatewayResponse {
  return jsonResponse(status, body, [['Content-Type', JSON_CHARSET], ...headers])
}

/** Text/plain response (WebSocket handshake failure, gorilla style). */
export function plainText(status: number, body: string, headers: HeaderList = []): GatewayResponse {
  return jsonResponse(status, body, [['Content-Type', 'text/plain; charset=utf-8'], ...headers])
}

/** HTML response. */
export function html(status: number, body: string, headers: HeaderList = []): GatewayResponse {
  return jsonResponse(status, body, [['Content-Type', HTML_CONTENT_TYPE], ...headers])
}

/** Route-level 404: empty body, no content type (ruling R-404). */
export function emptyNotFound(): GatewayResponse {
  return { status: 404, headers: [], body: '' }
}

/** OpenAI-shaped request error: `{"error":{message,type[,code][,param]}}`. */
export function openAiError(message: string, type: string, code?: string, param?: string): string {
  const error: Record<string, unknown> = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return JSON.stringify({ error })
}

/** Route-level `model_not_found` (S1 section 8). */
export function modelNotFoundBody(model: string): string {
  return openAiError(`unknown provider for model ${model}`, 'invalid_request_error', 'model_not_found', 'model')
}

/** Claude-surface collapse of `model_not_found`. */
export function claudeModelNotFoundBody(model: string): string {
  return JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: `unknown provider for model ${model}`.trim() },
  })
}

/** Claude-surface request error envelope. */
export function claudeInvalidRequestBody(message: string): string {
  return JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message },
  })
}

/** Route-level invalid-request body for the OpenAI-family surfaces. */
export function invalidRequestBody(message: string): string {
  return openAiError(`Invalid request: ${message}`, 'invalid_request_error')
}

/** Depth-rejection wording for the hostile-input guard (unpinned). */
export const MAX_DEPTH_MESSAGE = 'Invalid request: exceeded max depth'

/** Pinned zstd decode-failure wording (S1-25 magic-mismatch golden). */
export const ZSTD_MAGIC_MISMATCH = 'failed to decode zstd request body: invalid input: magic number mismatch'

/** Realtime nested envelope, map-sorted keys (S1 section 3.7). */
export function realtimeEnvelope(code: string, message: string, type: string): string {
  return JSON.stringify({
    error: { code, message, param: null, type },
  })
}

/** Plain string-error envelope: `{"error":"<message>"}`. */
export function plainErrorBody(message: string): string {
  return JSON.stringify({ error: message })
}

/** 503 body for the codex-only routes without codex credentials (S1-23). */
export const CODEX_AUTH_UNAVAILABLE_BODY = '{"error":"auth_not_found: no auth available"}'

/** Compact-responses stream rejection (S1-18). */
export function compactStreamRejectionBody(): string {
  return openAiError('Streaming not supported for compact responses', 'invalid_request_error')
}

/** Image-only model on a non-image route (S1-25, 503). */
export function imageOnlyModelBody(model: string): string {
  return JSON.stringify({
    error: {
      message: `model ${model} is only supported on /v1/images/generations and /v1/images/edits`,
      type: 'server_error',
      code: 'internal_server_error',
    },
  })
}

/** Unsupported images-model rejection (S1-25, 400, recorded text). */
export function imagesUnsupportedModelBody(model: string): string {
  return openAiError(
    `Model ${model} is not supported on /v1/images/generations or /v1/images/edits. Use ${IMAGE_MODEL_LIST_TEXT}`,
    'invalid_request_error',
  )
}

const IMAGE_MODEL_LIST_TEXT =
  'gpt-image-1.5, gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2.5, grok-imagine-image, grok-imagine-image-quality, grok-imagine-image-2.0, or a configured openai-compatibility image model.'

/** Interactions-surface validation bodies (S1-25). */
export const INTERACTIONS_INVALID_JSON_BODY = '{"error":{"message":"invalid JSON body","type":"invalid_request_error"}}'
export const INTERACTIONS_EXACTLY_ONE_BODY =
  '{"error":{"message":"request requires exactly one of model or agent","type":"invalid_request_error"}}'
export const INTERACTIONS_STREAM_BOOLEAN_BODY = '{"error":{"message":"stream must be a boolean","type":"invalid_request_error"}}'

/**
 * Dispatch-seam response: a direction this build has no merged facade
 * for. The body is deliberately NOT any upstream-pinned shape so no
 * golden can mistake it for reference behavior.
 */
export function directionNotMergedBody(): string {
  return JSON.stringify({
    error: {
      message: 'direction not yet available in this build',
      type: 'server_error',
      code: 'not_implemented',
    },
  })
}

/** Root info payload (S1 section 6.1). */
export const ROOT_BODY =
  '{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}'

/** `GET /healthz` success body. */
export const STATUS_OK_BODY = '{"status":"ok"}'

/** Trailing-slash redirect body for GET (301) requests (gin form). */
export function trailingSlashRedirectBody(location: string): string {
  return `<a href="${location}">Moved Permanently</a>.\n`
}

// ---------------------------------------------------------------------------
// Platform-degradation bodies (S7 section 3.2, exact bytes)
// ---------------------------------------------------------------------------

/**
 * F1 client body: every eligible credential for the resolved model is
 * proxy-credentialed and this runtime cannot honor proxies.
 */
export const PROXY_UNAVAILABLE_CLIENT_BODY =
  '{"error":{"message":"outbound proxy transport (proxy-url) is not available on this runtime","type":"not_implemented","code":"proxy_unavailable"}}'

/** F5 management body: redirect-flow auth-URLs need a loopback listener. */
export const LOCAL_CALLBACK_UNAVAILABLE_BODY =
  '{"error":"local callback server is not available on this runtime"}'

/** F1 management body: api-call resolved to a proxy this runtime lacks. */
export const PROXY_UNAVAILABLE_MGMT_BODY =
  '{"error":"proxy transport is not available on this runtime"}'

/** F2 management body: plugin installation is absent project-wide. */
export const PLUGIN_INSTALL_UNAVAILABLE_BODY =
  '{"error":"plugin installation is not available on this runtime"}'

/** Gorilla-style handshake rejection body (12 recorded bytes, S7-02). */
export const WEBSOCKET_BAD_REQUEST_BODY = 'Bad Request\n'

/** 501 helper: management-style degraded body with the CORS block applied later. */
export function degraded501(body: string): GatewayResponse {
  return charsetJson(501, body)
}

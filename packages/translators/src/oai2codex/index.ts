/**
 * OpenAI Chat Completions client -> Codex (Responses API) upstream.
 *
 * Pure translation core for the S2d5 direction: no transport, no fetch, no
 * platform APIs beyond the Web Standards. The executor owns the HTTP call
 * (`<base-url>/responses`, always requested as SSE) and the downstream route
 * owns framing; everything wire-observable is produced here.
 */
export { CODEX_DEFAULT_BASE_URL, CODEX_ORIGINATOR, CODEX_RESPONSES_PATH, CODEX_USER_AGENT } from './types'
export type {
  ChatToCodexContext,
  CodexSessionContext,
  CodexSseFrame,
  CodexToChatContext,
  CodexUpstreamRequest,
  WireObject,
  WireValue,
} from './types'

export { CODEX_IMAGE_GENERATION_TOOL, translateChatToCodex, translateReasoning, translateToolChoice } from './request'

export {
  CODEX_COMPLEX_UNION_BRANCH_THRESHOLD,
  CODEX_TOOL_NAME_LIMIT,
  buildShortNameMap,
  normalizeCodexParameters,
  normalizeCodexToolSchemasInBody,
  restoreToolName,
  sanitizeToolName,
  shortenSanitizedName,
  shortenToolName,
} from './tools'

export { callerScopeHash, deriveCodexSessionId, truncateRunes, uuidV5 } from './session'

export { buildCodexUpstreamHeaders, gatewayUserAgent, orderCodexUpstreamHeaders } from './headers'
export type { CodexUpstreamHeadersInput, HeaderList } from './headers'

export { decodeSseFrames, formatSseData, formatSseDone, parseDownstreamSse, scanDataLines } from './sse'

export {
  CodexStreamChunkTranslator,
  codexUsageObject,
  imageMimeType,
  incompleteFinishReason,
  serviceTierOf,
  translateCodexBufferToChatCompletion,
} from './response'
export type { CodexNonStreamResult, CodexStreamLineResult } from './response'

export { bootstrapCodexChunkStream, translateCodexSseToChatSse } from './stream'
export type { CodexStreamBootstrap } from './stream'
export { CodexPreCommitError } from './stream'

export {
  MESSAGE_EMPTY_INCOMPLETE,
  MESSAGE_STREAM_DISCONNECTED,
  UPSTREAM_STREAM_FAILED_WITHOUT_DETAILS,
  buildErrorEnvelopeBody,
  buildModelCooldownResponse,
  classifyCodexUpstreamError,
  codexTerminalFailureBody,
  codexTerminalFailureStatus,
  emptyIncompleteBody,
  formatInStreamErrorFrame,
  goDuration,
  incompleteStreamBody,
  invalidRequestBody,
  renderUpstreamFailure,
  sanitizeUpstreamErrorSummary,
  unknownProviderEnvelope,
  wrapTypeForStatus,
} from './errors'
export type { CodexUpstreamFailure, ModelCooldownResponse } from './errors'

export { createOai2CodexService } from './service'
export type {
  Oai2CodexChatRequest,
  Oai2CodexChatResponse,
  Oai2CodexChatService,
  Oai2CodexCredential,
  Oai2CodexModelEntry,
  Oai2CodexServiceOptions,
  Oai2CodexUpstreamRequest,
  Oai2CodexUpstreamResponse,
  Oai2CodexUpstreamSender,
} from './service'

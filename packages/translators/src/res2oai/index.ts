/**
 * Responses client -> OpenAI chat (openai-compatibility) upstream — the
 * S2d6 direction module.
 *
 * Pure translation core plus the composed facade: no transport, no
 * platform APIs beyond the Web Standards. The executor owns the HTTP
 * call (`<base>/chat/completions`, compact: `<base>/responses/compact`;
 * UA `cli-proxy-openai-compat`; stream requests add the SSE header pair
 * and `stream_options.include_usage`) and the downstream route owns the
 * final framing; everything wire-observable is produced here.
 */
export { CHAT_COMPLETIONS_PATH, OPENAI_COMPAT_USER_AGENT, RESPONSES_COMPACT_PATH, UPSTREAM_DONE } from './types'
export type {
  ChatToResponsesContext,
  ChatToResponsesStreamContext,
  ChatUpstreamRequest,
  DeclaredTool,
  ResponsesToChatContext,
  SseFrame,
} from './types'
export type { WireObject, WireValue } from './json'

export { RawJson, isPlainObject, marshalSorted, parseStrictJson, serializeOrdered, sortKeysDeep, tryParseJson, wireValueOf } from './json'

export {
  CUSTOM_TOOL_PARAMETERS,
  chatToolCallEntry,
  collectToolSources,
  customToolArguments,
  qualifyToolName,
  resolveCallName,
  serializeChatTool,
  serializeChatTools,
  translateToolChoice,
  translateToolDeclarations,
} from './tools'

export { REASONING_UNAVAILABLE, translateResponsesToChat, translateReasoningEffort, translateResponseFormat } from './request'
export { translateCompactPassthrough } from './compact'

export {
  COMPACTION_OBJECT,
  customInputOf,
  ensureResponsesUsageDetails,
  translateChatToResponses,
} from './response'

export {
  ChatToResponsesStreamTranslator,
  PreCommitStreamError,
  bootstrapResponsesStream,
  classifyStreamError,
  translateChatSseToResponsesFrames,
} from './stream'
export type { EmittedEvent, ResponsesStreamBootstrap, StreamPipelineOptions } from './stream'

export {
  CLOSED_BEFORE_DONE_MESSAGE,
  EMPTY_STREAM_MESSAGE,
  RATE_LIMIT_COOLDOWN_MS,
  UNEXPECTED_EOF_MESSAGE,
  buildCompactStreamRejectedEnvelope,
  buildErrorEnvelopeBody,
  buildMalformedBodyEnvelope,
  buildModelCooldownResponse,
  buildModelNotFoundEnvelope,
  buildPlainErrorBody,
  classifyUpstreamError,
  closeErrorText,
  formatTerminalErrorFrame,
  isCodexClient,
  normalizeErrorStatus,
  renderEmptyStreamFailure,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  sanitizeErrorDetail,
  sanitizeInitialStreamError,
  statusStreamFailure,
  streamErrorTypeForStatus,
  upstreamStreamFailure,
  wrapTypeForStatus,
} from './errors'
export type { StreamFailure, UpstreamFailure } from './errors'

export { buildUpstreamHeaders, headerListToRecord, orderUpstreamHeaders, readHeaderValue } from './headers'
export type { HeaderList, UpstreamHeadersInput } from './headers'

export { decodeSseFrames, frameBytes, frameEvent, parseDownstreamSse } from './sse'
export type { ResponsesStreamFrame } from './sse'

export { createRes2OaiService, withStreamOptions } from './service'
export type {
  Res2OaiCredential,
  Res2OaiModelEntry,
  Res2OaiRequest,
  Res2OaiResponse,
  Res2OaiService,
  Res2OaiServiceOptions,
  Res2OaiUpstreamRequest,
  Res2OaiUpstreamResponse,
  Res2OaiUpstreamSender,
} from './service'

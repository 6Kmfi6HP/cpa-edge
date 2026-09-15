/**
 * OpenAI chat-completions client -> OpenAI-compatibility upstream
 * (the chat seam over the openai-compat executor).
 *
 * Pure translation core plus the composed facade: no fetch, no platform
 * APIs beyond the Web Standards. The runtime owns routing, the client
 * auth gate and trace emission; the executor transport is injected into
 * the facade, and every wire-observable byte is produced here.
 */
export type {
  ChatPassthroughContext,
  ChatPassthroughRequest,
  ChatResponseContext,
  DownstreamStreamEvent,
  HeaderList,
  SseFrame,
  WireObject,
  WireValue,
} from './types'

export {
  appendMember,
  ensureTopLevelFlag,
  isPlainObject,
  isValidJson,
  lastMemberSpan,
  parseStrictJson,
  readString,
  replaceValueSpan,
  scanLeadingJsonValue,
  serializeJsonString,
  serializeOrdered,
  setTopLevelStringIfDifferent,
  topLevelStart,
} from './json'
export type { LeadingValue, MemberSpan } from './json'

export {
  OPENAI_COMPAT_USER_AGENT,
  buildUpstreamHeaders,
  headerListToRecord,
  headerValue,
  orderUpstreamHeaders,
  readHeaderValue,
} from './headers'
export type { UpstreamHeadersInput } from './headers'

export {
  INCLUDE_USAGE_FLAG,
  STREAM_OPTIONS_KEY,
  translateChatPassthrough,
} from './request'

export { dataFrame, decodeUpstreamSse, DONE_TERMINATOR } from './sse'

export { reframeUpstreamFrame, reframeUpstreamSse, rewriteResponseModel } from './stream'

export {
  UNEXPECTED_EOF_MESSAGE,
  buildModelCooldownResponse,
  classifyUpstreamError,
  invalidRequestBody,
  isTpmRateLimitBody,
  isUpstreamErrorPayload,
  modelNotFoundBody,
  openAIErrorBody,
  plainErrorBody,
  renderGatewayError,
  renderUpstreamFailure,
  serverErrorBody,
  transportErrorMessage,
  transportFailureBody,
  upstreamErrorStatus,
  upstreamErrorSummary,
  wrapTypeForStatus,
} from './errors'
export type { ModelCooldownResponse, UpstreamFailure } from './errors'

export { createOai2OaiService } from './service'
export type {
  Oai2OaiCredential,
  Oai2OaiModelEntry,
  Oai2OaiRequest,
  Oai2OaiResponse,
  Oai2OaiService,
  Oai2OaiServiceOptions,
  Oai2OaiUpstreamRequest,
  Oai2OaiUpstreamResponse,
  Oai2OaiUpstreamSender,
} from './service'

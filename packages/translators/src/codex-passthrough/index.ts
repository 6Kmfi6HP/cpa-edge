/**
 * Codex/Responses passthrough (S2d9): Responses client -> Codex Responses
 * upstream over `codex-api-key` + `base-url` credentials.
 *
 * The upstream wire is the same Responses protocol the client speaks, so
 * this direction PASSES THROUGH and patches: request bodies are edited in
 * place (model alias resolution, forced booleans, the image-generation
 * matrix, input rebuilds, session identity), SSE frames are forwarded
 * with byte fidelity (event names preserved, per-frame usage-detail
 * injection, terminal output repair, in-stream failure synthesis), and
 * non-stream clients aggregate the always-SSE upstream into one JSON
 * response. Pure translation core + the composed facade: no transport,
 * no fetch, no platform APIs beyond the Web Standards.
 */
export { CODEX_DEFAULT_BASE_URL, RESPONSES_COMPACT_PATH, RESPONSES_PATH } from './service'
export type {
  CodexPassthroughCredential,
  CodexPassthroughModelEntry,
  CodexPassthroughRequest,
  CodexPassthroughResponse,
  CodexPassthroughService,
  CodexPassthroughServiceOptions,
  CodexPassthroughUpstreamRequest,
  CodexPassthroughUpstreamResponse,
  CodexPassthroughUpstreamSender,
} from './service'
export { createCodexPassthroughService } from './service'

export type { HeaderList } from './headers'
export {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  buildPassthroughUpstreamHeaders,
  canonicalHeaderName,
  gatewayUserAgent,
  headerListToRecord,
  orderPassthroughUpstreamHeaders,
  readHeaderValue,
} from './headers'
export type { PassthroughUpstreamHeadersInput } from './headers'

export type { ImageGenerationMode, PassthroughRequestContext, PassthroughUpstreamRequest } from './request'
export { IMAGE_GENERATION_TOOL_JSON, translateCompactPassthrough, translateResponsesPassthrough } from './request'

export { resolveSessionIdentity } from './session'
export type { PassthroughSessionContext, SessionResolution } from './session'

export { isValidEncryptedContent } from './signature'
export { decodeBase64Url } from './base64'
export { planInputItemIds, ITEM_ID_PREFIXES, ITEM_ID_RUNE_LIMIT } from './ids'
export type { ItemIdAction, ItemIdInput } from './ids'

export {
  PassthroughPreCommitError,
  aggregatePassthroughStream,
  bootstrapPassthroughStream,
  translatePassthroughStream,
} from './stream'
export type { PassthroughStreamBootstrap, PassthroughStreamContext } from './stream'

export {
  COMPACTION_OBJECT,
  hydrateOutputItemIds,
  injectResponseModel,
  renameTypeValue,
  repairEmptyOutput,
  rewriteModelFields,
  transformFramePayload,
  ensureUsageDetails,
} from './response'
export type { FrameOutcome, FrameTransformContext, FrameTransformState, RecordedOutputItem } from './response'

export { formatDataLine, parseDownstreamSse, scanSseLines } from './sse'
export type { SseBlankEvent, SseEndEvent, SseLineEvent, SseScanItem } from './sse'

export {
  buildAuthUnavailableResponse,
  buildModelCooldownResponse,
  classifyUpstreamStatusError,
  codexTerminalFailureStatus,
  compactStreamRejectedBody,
  formatGoDurationMs,
  formatTerminalFailureFrame,
  incompleteStreamBody,
  invalidApiKeyBody,
  invalidRequestBody,
  isCodexClient,
  missingApiKeyBody,
  modelNotFoundBody,
  preCommitFailureBody,
  sanitizeErrorDetail,
  sanitizeUpstreamErrorSummary,
  serverErrorEnvelope,
  STREAM_DISCONNECTED_MESSAGE,
  synthesizedDetailForStatus,
  terminalFailureDetail,
  truncateRunes,
} from './errors'
export type { AuthUnavailableResponse, ModelCooldownResponse, UpstreamStatusFailure } from './errors'

export {
  appendElement,
  appendMember,
  deleteElement,
  deleteMember,
  isPlainObject,
  marshalSorted,
  parseStrictJson,
  rawSpanAt,
  rawValueAt,
  remarshalSortedRaw,
  replaceMemberValue,
  scanArrayElements,
  scanObjectMembers,
  serializeOrdered,
  sortKeysDeep,
  tryParseJson,
  wireValueOf,
} from './json'
export type { RawElement, RawJson, RawMember, RawSpan, WireObject, WireValue } from './json'

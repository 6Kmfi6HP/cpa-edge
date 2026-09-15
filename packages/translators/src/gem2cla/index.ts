/**
 * Gemini client -> Claude (Anthropic Messages) upstream — the S2d7
 * direction module.
 *
 * Pure translation core plus the composed facade: no transport, no
 * fetch, no platform APIs beyond the Web Standards. The executor owns
 * the HTTP call ({@link CLAUDE_MESSAGES_PATH} always carries
 * `?beta=true`, the upstream body always carries `"stream":true`) and the
 * downstream route owns framing; everything wire-observable is produced
 * here.
 */
export { CLAUDE_MESSAGES_PATH } from './types'
export type {
  ClaudeContentAssembly,
  ClaudeToGeminiContext,
  ClaudeUpstreamRequest,
  DownstreamFraming,
  GeminiToClaudeContext,
  ModelThinkingCapability,
  SseFrame,
  WireObject,
  WireValue,
} from './types'

export { RawJson, parseStrictJson, serializeOrdered, sortKeysDeep, rawValueAt } from './json'
export { isPlainObject } from './json'

export {
  CLAUDE_DEFAULT_MAX_TOKENS,
  GENERATED_TOOL_ID_PREFIX,
  assembleClaudeContent,
  translateGeminiToClaude,
} from './request'

export { deriveClaudeUserId, firstContentTextSeed, sha256Hex } from './userid'

export { TOOL_SCHEMA_DRAFT_URI, cleanToolParameters, claudeToolObject } from './schema'

export {
  ClaudeToGeminiStreamTranslator,
  MESSAGE_EMPTY_STREAM,
  MESSAGE_ENDED_BEFORE_COMPLETION,
  MESSAGE_ERROR_EVENT_PREFIX,
  MESSAGE_MALFORMED_STREAM,
  MESSAGE_MISSING_MESSAGE_START,
  MESSAGE_START_MISSING_ID_OR_MODEL,
  TRAFFIC_TYPE,
  UNKNOWN_UPSTREAM_ERROR,
  consolidateParts,
  formatRfc3339Seconds,
  inStreamErrorChunk,
  scanDataLines,
  translateClaudeBufferToGemini,
  validateClaudeAggregatedStream,
} from './response'
export type { AggregatedEvent, AggregatedStreamValidation, GeminiNonStreamResult } from './response'

export {
  TOKEN_COUNT_BLOCKS,
  TOKEN_COUNT_CONTENT,
  TOKEN_COUNT_INVALID_JSON,
  TOKEN_COUNT_MESSAGES_EMPTY,
  TOKEN_COUNT_MESSAGES_OBJECTS,
  TOKEN_COUNT_NOT_OBJECT,
  TOKEN_COUNT_ROLE,
  claudeInputSegments,
  countSegments,
  estimateClaudeInputTokens,
  geminiTokenCountBody,
  serializeTokenCountRequest,
  validateClaudeTokenCountRequest,
} from './tokens'
export type { TokenCountValidation } from './tokens'

export {
  EMPTY_STREAM_MESSAGE,
  UNEXPECTED_EOF_MESSAGE,
  buildErrorEnvelopeBody,
  buildModelCooldownResponse,
  buildPlainErrorBody,
  classifyClaudeUpstreamError,
  formatTerminalErrorFrame,
  parseClaudeRateLimitReset,
  parseClaudeRateLimitResetWithFuzz,
  renderEmptyStreamFailure,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  renderValidationFailure,
} from './errors'
export type { ClaudeUpstreamFailure, ModelCooldownResponse } from './errors'

export {
  DEFAULT_ANTHROPIC_VERSION,
  buildClaudeUpstreamHeaders,
  gatewayUserAgent,
  orderUpstreamHeaders,
} from './headers'
export type { ClaudeUpstreamHeadersInput } from './headers'

export { decodeSseFrames, frameForMode, parseDownstreamSse } from './sse'
export type { GeminiStreamFrame } from './sse'

export { bootstrapGeminiStream, translateClaudeSseToGeminiFrames } from './stream'
export type { GeminiStreamBootstrap } from './stream'

export { createGem2ClaService } from './service'
export type {
  Gem2ClaCredential,
  Gem2ClaModelEntry,
  Gem2ClaRequest,
  Gem2ClaResponse,
  Gem2ClaService,
  Gem2ClaServiceOptions,
  Gem2ClaUpstreamRequest,
  Gem2ClaUpstreamResponse,
  Gem2ClaUpstreamSender,
  HeaderList,
} from './service'

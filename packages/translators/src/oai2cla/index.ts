/**
 * OpenAI Chat Completions client -> Claude (Anthropic Messages) upstream.
 *
 * Pure translation core for the S2d3 direction: no transport, no fetch, no
 * platform APIs beyond the Web Standards. The executor owns the HTTP call
 * ({@link CLAUDE_MESSAGES_PATH} always carries `?beta=true`) and the
 * downstream route owns framing; everything wire-observable is produced
 * here.
 */
export { CLAUDE_MESSAGES_PATH } from './types'
export type {
  ClaudeCodeCliIdentity,
  ClaudeToChatContext,
  ClaudeUpstreamRequest,
  ChatToClaudeContext,
  ModelSuffix,
  ModelThinkingCapability,
  SseFrame,
  WireObject,
  WireValue,
} from './types'

export { CLAUDE_DEFAULT_MAX_TOKENS, JSON_OBJECT_INSTRUCTION, parseModelSuffix, translateChatToClaude } from './request'
export { deriveClaudeUserId, firstUserMessageText } from './userid'
export { normalizeToolInputSchema, parseToolArguments, sanitizeClaudeToolId } from './schema'

export {
  ClaudeStreamChunkTranslator,
  MESSAGE_EMPTY_STREAM,
  MESSAGE_ENDED_BEFORE_COMPLETION,
  MESSAGE_MALFORMED_STREAM,
  MESSAGE_MISSING_MESSAGE_START,
  MESSAGE_START_MISSING_ID_OR_MODEL,
  UNKNOWN_UPSTREAM_ERROR,
  emptyUsage,
  mapStopReason,
  mergeUsage,
  scanDataLines,
  translateClaudeBufferToChatCompletion,
  usageObject,
  validateClaudeAggregatedStream,
  zeroUsageObject,
} from './response'
export type { AggregatedEvent, AggregatedStreamValidation, ChatNonStreamResult, UsageTracker } from './response'

export { decodeSseFrames, formatSseData, formatSseDone, parseDownstreamSse } from './sse'

export {
  bootstrapChatChunkStream,
  translateClaudeSseToChatSse,
} from './stream'
export type { ChatStreamBootstrap } from './stream'

export {
  EMPTY_STREAM_MESSAGE,
  buildErrorEnvelopeBody,
  buildModelCooldownResponse,
  classifyClaudeUpstreamError,
  formatInStreamErrorFrame,
  parseClaudeRateLimitReset,
  parseClaudeRateLimitResetWithFuzz,
  renderEmptyStreamFailure,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  renderValidationFailure,
  wrapTypeForStatus,
} from './errors'
export type { ClaudeUpstreamFailure, ModelCooldownResponse } from './errors'

export { DEFAULT_ANTHROPIC_VERSION, buildClaudeUpstreamHeaders, gatewayUserAgent } from './headers'
export type { ClaudeUpstreamHeadersInput } from './headers'

export {
  CLAUDE_CODE_CLI_APP,
  CLAUDE_CODE_CLI_BETAS,
  CLAUDE_CODE_CLI_BILLING_TEXT,
  CLAUDE_CODE_CLI_CACHE_CONTROL,
  CLAUDE_CODE_CLI_PERSONA_TEXT,
  CLAUDE_CODE_CLI_STAINLESS_HEADERS,
  CLAUDE_CODE_CLI_TIMEOUT_SECONDS,
  CLAUDE_CODE_CLI_USER_AGENT,
  claudeCodeCliBetas,
  claudeCodeCliDateContextBlock,
  claudeCodeCliSystemBlocks,
  claudeCodeCliUserId,
} from './profile'

export { createOai2ClaChatService } from './service'
export type {
  HeaderList,
  Oai2ClaChatRequest,
  Oai2ClaChatResponse,
  Oai2ClaChatService,
  Oai2ClaCredential,
  Oai2ClaModelEntry,
  Oai2ClaServiceOptions,
  Oai2ClaUpstreamRequest,
  Oai2ClaUpstreamResponse,
  Oai2ClaUpstreamSender,
} from './service'

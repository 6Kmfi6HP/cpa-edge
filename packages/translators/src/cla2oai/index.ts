/**
 * Claude client (Messages API) -> OpenAI Chat Completions upstream.
 *
 * Pure translation core for the S2d4 direction plus the composed facade:
 * no fetch, no platform APIs beyond the Web Standards. The runtime owns
 * the HTTP listener and CORS; the executor transport is injected into
 * the facade, and every wire-observable byte is produced here.
 */
export type { HeaderList, ThinkingCapability, WireObject, WireValue } from './types'
export {
  DEFAULT_OPENAI_COMPAT_THINKING,
  MODEL_CLOAK_PREFIX,
  decodeCloakedModelId,
} from './types'
export type { Cla2OaiContext, Cla2OaiUpstreamBody } from './types'

export {
  RawJson,
  isPlainObject,
  isValidJson,
  parseStrictJson,
  rawSpanAt,
  rawValueAt,
  readArray,
  readObject,
  readString,
  serializeOrdered,
  sortKeysDeep,
} from './json'
export type { RawSpan, WireObject as JsonWireObject, WireValue as JsonWireValue } from './json'

export {
  argumentsAreValidObject,
  buildToolNameIndex,
  fixJson,
  generatedToolUseId,
  normalizeObjectSchemaProperties,
  parseToolArguments,
  requestToolList,
  restoreToolName,
  sanitizeClaudeToolId,
  serializeToolParameters,
  usesUnsupportedPropertyEscape,
} from './schema'
export type { ToolNameIndex } from './schema'

export {
  applyRequestThinking,
  convertBudgetToLevel,
  effectiveThinkingLevel,
  extractSourceThinkingConfig,
} from './thinking'
export type { SourceThinkingConfig } from './thinking'

export {
  buildSystemMessage,
  buildToolChoice,
  buildTools,
  buildMessages,
  imagePart,
  translateClaudeToOpenAI,
} from './request'

export {
  captureFinishReason,
  extractOpenAIUsage,
  extractReasoningTexts,
  formatClaudeEvent,
  mapFinishReasonToStopReason,
  messageStartEvent,
  streamErrorEvent,
  toolUseBlock,
  translateOpenAIResponseToClaude,
} from './response'
export type { OpenAIToClaudeContext } from './response'

export {
  OpenAIToClaudeStreamTranslator,
  StreamFailureError,
  bootstrapCla2OaiStream,
  decodeUpstreamSseFrames,
  isUpstreamErrorPayload,
  translateOpenAIToClaudeFrames,
  upstreamErrorStatus,
} from './stream'
export type {
  Cla2OaiStreamBootstrap,
  Cla2OaiStreamContext,
  DownstreamFrame,
  SseFrame,
  UpstreamSseEvent,
} from './stream'

export {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  UNEXPECTED_EOF_MESSAGE,
  buildClaudeErrorEnvelope,
  buildModelCooldownResponse,
  claudeErrorTypeForStatus,
  extractClaudeError,
  headerValue,
  isTpmRateLimitBody,
  openAICompatProviderKey,
  parseRetryAfterSeconds,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  summarizeUpstreamError,
  unknownProviderEnvelope,
} from './errors'
export type { ClaudeErrorExtraction, ModelCooldownResponse } from './errors'

export {
  claudeRequestSegments,
  countTranslatedBodyTokens,
  encodingForUpstreamModel,
  estimateClaudeInputTokens,
  renderCountTokensResponse,
} from './tokens'

export { authenticateClientRequest, extractClientCredentials } from './auth'
export type { ClientAuthResult } from './auth'

export { createCla2OaiService, OPENAI_COMPAT_USER_AGENT } from './service'
export type {
  Cla2OaiCredential,
  Cla2OaiModelEntry,
  Cla2OaiRequest,
  Cla2OaiResponse,
  Cla2OaiService,
  Cla2OaiServiceOptions,
  Cla2OaiUpstreamRequest,
  Cla2OaiUpstreamResponse,
  Cla2OaiUpstreamSender,
} from './service'

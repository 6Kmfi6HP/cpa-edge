/**
 * Gemini client (generateContent / streamGenerateContent / countTokens)
 * -> OpenAI Chat Completions upstream.
 *
 * Pure translation core for the S2d2 direction plus the composed facade:
 * no fetch, no platform APIs beyond the Web Standards. The runtime owns
 * the HTTP listener and CORS; the executor transport is injected into the
 * facade, and every wire-observable byte is produced here.
 */
export { DEFAULT_OPENAI_COMPAT_THINKING } from './types'
export type {
  DownstreamFraming,
  DownstreamStreamEvent,
  GeminiToOpenAIContext,
  GeminiUpstreamRequest,
  HeaderList,
  OpenAIToGeminiContext,
  SseFrame,
  ThinkingCapability,
  WireObject,
  WireValue,
} from './types'
export { DEFAULT_GENERATION_METHODS as MODEL_LIST_DEFAULT_METHODS } from './models'

export {
  applyRequestThinking,
  convertBudgetToLevel,
  effectiveThinkingLevel,
  extractSourceThinkingConfig,
} from './thinking'
export type { SourceThinkingConfig } from './thinking'

export {
  deriveToolCallId,
  sha256Hex,
  translateGeminiRequest,
  translateGeminiToOpenAI,
  withStreamOptions,
} from './request'

export {
  extractReasoningTexts,
  functionCallPart,
  mapFinishReason,
  parseToolArguments,
  translateOpenAIResponseToGeminiNonStream,
  usageMetadata,
} from './response'

export {
  OpenAIChunkTranslator,
  decodeUpstreamSse,
  frameDownstreamEvent,
  framingForAlt,
  isUpstreamErrorPayload,
  translateOpenAIStreamToGemini,
  upstreamErrorStatus,
} from './stream'
export type { UpstreamSseEvent } from './stream'

export {
  countTranslatedBodyTokens,
  encodingForUpstreamModel,
  renderCountTokensResponse,
} from './count'

export {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  MODEL_GET_NOT_FOUND_BODY,
  UNEXPECTED_EOF_MESSAGE,
  actionNotFoundBody,
  buildModelCooldownResponse,
  classifyUpstreamError,
  isTpmRateLimitBody,
  modelNotFoundBody,
  openAIErrorBody,
  parseRetryAfterSeconds,
  renderGatewayError,
  renderUpstreamFailure,
  transportErrorMessage,
  upstreamErrorSummary,
  wrapTypeForStatus,
} from './errors'
export type { ModelCooldownResponse, OpenAIUpstreamFailure } from './errors'

export {
  parseModelMethod,
  rawModelRecord,
  registryEntryById,
  renderModelsList,
  splitV1BetaPath,
} from './models'
export type { Gem2OaiRegistryEntry, V1BetaTarget } from './models'

export { authenticateV1Beta, extractClientCredentials } from './auth'
export type { ClientAuthResult } from './auth'

export { createGem2OaiService, openAICompatUserAgent } from './service'
export type {
  Gem2OaiCredential,
  Gem2OaiModelEntry,
  Gem2OaiRequest,
  Gem2OaiResponse,
  Gem2OaiService,
  Gem2OaiServiceOptions,
  Gem2OaiUpstreamRequest,
  Gem2OaiUpstreamResponse,
  Gem2OaiUpstreamSender,
} from './service'

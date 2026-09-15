/**
 * OpenAI Chat Completions client -> Gemini (GenerateContent) upstream.
 *
 * Pure translation core for the S2d1 direction plus the composed facade:
 * no fetch, no platform APIs beyond the Web Standards. The runtime owns
 * the HTTP listener, routing and CORS; the executor transport is injected
 * into the facade, and every wire-observable byte is produced here.
 */
export {
  DEFAULT_PARAMETERS_JSON_SCHEMA,
  buildGeminiTools,
  cleanGeminiSchema,
  sanitizeFunctionName,
} from './schema'

export {
  SAFETY_SETTINGS,
  SKIP_THOUGHT_SIGNATURE,
  parseDataUrl,
  parseModelSuffix,
  stripModelSuffix,
  translateChatToGemini,
} from './request'
export type { ModelSuffix } from './request'

export {
  chatUsageObject,
  createdSeconds,
  readGeminiUsage,
  toolCallId,
  translateGeminiResponseToChatCompletion,
} from './response'

export {
  GeminiChunkTranslator,
  filterUpstreamUsage,
  translateGeminiStreamToChatChunks,
} from './stream'

export { decodeUpstreamDataLines, frameChunk, DONE_FRAME } from './sse'
export type { UpstreamDataLine } from './sse'

export {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  UNEXPECTED_EOF_MESSAGE,
  buildModelCooldownResponse,
  classifyUpstreamError,
  headerValue,
  modelNotFoundBody,
  openAIErrorBody,
  parseRetryAfterSeconds,
  renderUpstreamFailure,
  terminalErrorFrame,
  transportErrorMessage,
  wrapTypeForStatus,
} from './errors'
export type { GeminiUpstreamFailure, ModelCooldownResponse } from './errors'

export { GEMINI_UPSTREAM_USER_AGENT, buildGeminiUpstreamHeaders } from './headers'

export type {
  ChatToGeminiContext,
  DataUrlParts,
  DownstreamStreamEvent,
  GeminiToChatContext,
  GeminiUpstreamRequest,
  HeaderList,
  ThinkingCapability,
  WireObject,
  WireValue,
} from './types'

export { RawJson, serializeOrdered } from './json'

export { createOai2GemService, DEFAULT_GEMINI_BASE_URL } from './service'
export type {
  Oai2GemChatRequest,
  Oai2GemChatResponse,
  Oai2GemChatService,
  Oai2GemCredential,
  Oai2GemModelEntry,
  Oai2GemServiceOptions,
  Oai2GemUpstreamRequest,
  Oai2GemUpstreamResponse,
  Oai2GemUpstreamSender,
} from './service'

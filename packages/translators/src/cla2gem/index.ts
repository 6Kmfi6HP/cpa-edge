/**
 * Claude client -> Gemini (gemini-api-key) upstream — the S2d8 direction
 * module.
 *
 * Pure translation core plus the composed facade: no transport, no
 * fetch, no platform APIs beyond the Web Standards. The executor owns the
 * HTTP call (`{base}/v1beta/models/{model}:{action}` with the recorded
 * header set); the downstream route owns framing. Everything
 * wire-observable is produced here.
 */
export type { HeaderList } from './headers'
export {
  DEFAULT_GEMINI_BASE_URL,
  GEMINI_UPSTREAM_USER_AGENT,
  buildGeminiUpstreamHeaders,
  headerListToRecord,
} from './headers'

export { RawJson, isPlainObject, parseStrictJson, serializeOrdered, rawValueAt, rawSpanAt } from './json'
export type { WireObject, WireValue } from './json'

export {
  buildToolNameIndex,
  cleanGeminiSchema,
  requestToolList,
  restoreToolName,
  sanitizeClaudeToolId,
  sanitizeFunctionName,
} from './schema'
export type { ToolNameIndex } from './schema'

export {
  buildContents,
  buildGenerationConfig,
  buildSystemInstruction,
  buildToolConfig,
  translateClaudeToGemini,
} from './request'
export type { Cla2GemContext, Cla2GemUpstreamBody } from './types'

export { claudeRequestSegments, countSegments, estimateClaudeInputTokens } from './tokens'

export {
  DEFAULT_STREAM_MESSAGE_ID,
  DEFAULT_STREAM_MODEL,
  THOUGHT_SIGNATURE_SENTINEL,
} from './types'
export type { Cla2GemThinkingCapability } from './types'

export {
  claudeStopReason,
  claudeUsageObject,
  formatClaudeEvent,
  formatTerminalErrorEvent,
  readGeminiUsage,
  translateGeminiResponseToClaude,
  GeminiToClaudeStreamTranslator,
} from './response'
export type { GeminiToClaudeContext, GeminiUsage } from './response'

export { decodeUpstreamDataLines, frameDownstream, parseDownstreamSse } from './sse'
export type { UpstreamDataLine, DownstreamFrame } from './sse'

export {
  bootstrapCla2GemStream,
  PreCommitTransportError,
  translateGeminiSseToClaudeFrames,
} from './stream'
export type { Cla2GemStreamBootstrap, Cla2GemStreamContext } from './stream'

export {
  buildClaudeErrorEnvelope,
  buildInvalidRequestBody,
  buildModelCooldownResponse,
  claudeErrorTypeForStatus,
  COOLDOWN_PROVIDER,
  extractClaudeError,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  UNEXPECTED_EOF_MESSAGE,
} from './errors'
export type { ClaudeErrorExtraction } from './errors'

export { createCla2GemService } from './service'
export type {
  Cla2GemCredential,
  Cla2GemModelEntry,
  Cla2GemRequest,
  Cla2GemResponse,
  Cla2GemService,
  Cla2GemServiceOptions,
  Cla2GemUpstreamRequest,
  Cla2GemUpstreamResponse,
  Cla2GemUpstreamSender,
} from './service'

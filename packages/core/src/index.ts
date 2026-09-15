/**
 * Public surface of @cpa-edge/core. Everything else in this package is an
 * implementation detail; import through this module only.
 */
export type {
  ClaimHandle,
  JsonPrimitive,
  JsonValue,
  QueueClaim,
  Store,
  UpdateCallback,
} from './store'
export { DEFAULT_RING_CAPACITY, isJsonValue } from './store'
export type { MemoryStoreOptions } from './store-memory'
export { MemoryStore } from './store-memory'
export type { ErrorCode, ErrorDetails, ErrorEnvelope } from './errors'
export { ERROR_CODES, CpaError, createErrorEnvelope, isErrorCode, isErrorEnvelope } from './errors'

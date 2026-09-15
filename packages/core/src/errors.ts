import { isJsonValue } from './store'
import type { JsonValue } from './store'

/**
 * Stable error vocabulary of the platform. Every failure anywhere in
 * CPA-Edge maps to exactly one of these string codes. Runtimes translate
 * codes into HTTP statuses; nothing in this module knows about HTTP, so the
 * same codes serve workers, CLI tools and tests alike.
 */
const CODES = [
  'not-found',
  'invalid-input',
  'unauthorized',
  'forbidden',
  'rate-limited',
  'quota-exhausted',
  'upstream-error',
  'timeout',
  'conflict',
  'unavailable',
] as const

/** Union of all registered error codes. */
export type ErrorCode = (typeof CODES)[number]

/** The full code registry, frozen so no layer can extend it at runtime. */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(CODES)

/** Structured extra facts attached to an error; must itself be JSON data. */
export type ErrorDetails = Readonly<Record<string, JsonValue>>

/**
 * Runtime-neutral error report. `details` is absent when there is nothing
 * structured to add. This shape is what crosses runtime boundaries.
 */
export interface ErrorEnvelope {
  readonly code: ErrorCode
  readonly message: string
  readonly details?: ErrorDetails
}

/** Checks whether an unknown value names a registered error code. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Recognizes error envelopes that arrived from elsewhere (parsed JSON, other
 * isolates). Envelopes are valid only when their code is registered, their
 * message is a string, and their details - when present - are JSON data.
 * Field reads follow the prototype chain - a leniency `JSON.parse` output
 * can never trigger, but hand-built objects can.
 */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!isErrorCode(record['code'])) return false
  if (typeof record['message'] !== 'string') return false
  const details = record['details']
  if (details === undefined) return true
  return (
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    isJsonValue(details)
  )
}

/**
 * Builds a frozen envelope ready for logs, wires and assertions. The freeze
 * is shallow: the envelope and its details object are frozen, while values
 * nested inside details stay mutable and remain the caller's responsibility.
 */
export function createErrorEnvelope(
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
): ErrorEnvelope {
  const verifiedCode = requireCode(code)
  const verifiedMessage = requireMessage(message)
  if (details === undefined) {
    return Object.freeze({ code: verifiedCode, message: verifiedMessage })
  }
  return Object.freeze({ code: verifiedCode, message: verifiedMessage, details: freezeDetails(details) })
}

/**
 * Error carrying an {@link ErrorEnvelope}. Throw it anywhere in the platform;
 * runtimes map `code` to an HTTP status and serialize `envelope` for the
 * wire. `cause` keeps the original failure for logs when wrapping.
 */
export class CpaError extends Error {
  readonly code: ErrorCode
  readonly details: ErrorDetails | undefined
  /** The transport-neutral form of this error, ready for serialization. */
  readonly envelope: ErrorEnvelope

  constructor(code: ErrorCode, message: string, details?: ErrorDetails, cause?: unknown) {
    super(requireMessage(message), cause === undefined ? undefined : { cause })
    const verifiedCode = requireCode(code)
    const verifiedDetails = details === undefined ? undefined : freezeDetails(details)
    this.name = 'CpaError'
    this.code = verifiedCode
    this.details = verifiedDetails
    this.envelope =
      verifiedDetails === undefined
        ? Object.freeze({ code: verifiedCode, message })
        : Object.freeze({ code: verifiedCode, message, details: verifiedDetails })
  }

  /** Lets `JSON.stringify(error)` produce the envelope, not an empty object. */
  toJSON(): ErrorEnvelope {
    return this.envelope
  }
}

function requireCode(code: ErrorCode): ErrorCode {
  if (!isErrorCode(code)) {
    throw new CpaError('invalid-input', `unknown error code: ${String(code)}`)
  }
  return code
}

function requireMessage(message: string): string {
  if (typeof message !== 'string') {
    throw new CpaError('invalid-input', 'error message must be a string')
  }
  return message
}

function freezeDetails(details: ErrorDetails): ErrorDetails {
  const record: unknown = details
  if (
    typeof record !== 'object' ||
    record === null ||
    Array.isArray(record) ||
    !isJsonValue(record)
  ) {
    throw new CpaError('invalid-input', 'error details must be a JSON object')
  }
  return Object.freeze({ ...details })
}

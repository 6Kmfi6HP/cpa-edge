/**
 * The CORS block every non-redirect response carries (S1 section 2).
 *
 * Applied by the gateway after handlers run - on every status including
 * framework 404s and OPTIONS 204s. Trailing-slash redirects never reach
 * this layer (router-emitted, no `Access-Control-*` at all).
 */
import type { HeaderList } from './types'

/** Literal expose-headers value; header VALUES are not canonicalized. */
const EXPOSE_HEADERS =
  'X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id'

/** The four-header block in wire order (alphabetical, recorded). */
export const CORS_BLOCK: readonly (readonly [string, string])[] = [
  ['Access-Control-Allow-Headers', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  ['Access-Control-Allow-Origin', '*'],
  ['Access-Control-Expose-Headers', EXPOSE_HEADERS],
]

const CORS_NAMES = new Set(CORS_BLOCK.map(([name]) => name.toLowerCase()))

/**
 * Prepends the CORS block and drops any handler-set header that would
 * collide with it (facade SSE responses already set Allow-Origin).
 */
export function withCors(headers: HeaderList): Array<readonly [string, string]> {
  const kept = headers.filter(([name]) => !CORS_NAMES.has(name.toLowerCase()))
  return [...CORS_BLOCK, ...kept]
}

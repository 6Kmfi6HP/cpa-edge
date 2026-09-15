/**
 * `fingerprint-profile: claude-code-cli` wire identity (S2d3 case 21).
 *
 * A plain `claude-api-key` credential configured with this profile leaves the
 * caller-owned header mode and emits the Claude Code CLI surface instead:
 * the CLI user agent, the full beta assembly, the Stainless telemetry set,
 * the CLI session id, and a cloaked body (billing-header + persona system
 * blocks, a date-context system-reminder prepended to the first user
 * message, and a CLI identity JSON as `metadata.user_id`).
 *
 * Every recorded constant below is part of the anchored wire; the dynamic
 * values (session/account/device ids, calendar date) are injected through
 * {@link ClaudeCodeCliIdentity} so callers can pin or rotate them.
 */
import type { ClaudeCodeCliIdentity, WireObject } from './types'

/** User-Agent emitted by the CLI profile. */
export const CLAUDE_CODE_CLI_USER_AGENT = 'claude-cli/2.1.258 (external, cli)'

/**
 * Beta assembly sent by the CLI profile. The `effort` entry is managed: it
 * is dropped when the translated body carries a disabled thinking config or
 * a haiku model.
 */
export const CLAUDE_CODE_CLI_BETAS: readonly string[] = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
  'extended-cache-ttl-2025-04-11',
]

/** Telemetry headers emitted by the CLI profile (recorded values). */
export const CLAUDE_CODE_CLI_STAINLESS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Lang': 'js',
  'X-Stainless-Os': 'MacOS',
  'X-Stainless-Package-Version': '0.112.1',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v26.3.0',
  'X-Stainless-Timeout': '600',
})

/** `X-App` value for the CLI profile. */
export const CLAUDE_CODE_CLI_APP = 'cli'

/** Default request timeout advertised by the CLI profile, in seconds. */
export const CLAUDE_CODE_CLI_TIMEOUT_SECONDS = 600

/** Text of the billing-header system block. */
export const CLAUDE_CODE_CLI_BILLING_TEXT = 'x-anthropic-billing-header: cc_version=2.1.258.bcb; cc_entrypoint=cli;'

/** Text of the Claude Code persona system block. */
export const CLAUDE_CODE_CLI_PERSONA_TEXT = "You are Claude Code, Anthropic's official CLI for Claude."

/** Cache marker placed by the profile (extended TTL beta). */
export const CLAUDE_CODE_CLI_CACHE_CONTROL: Readonly<WireObject> = Object.freeze({
  type: 'ephemeral',
  ttl: '1h',
})

/** Builds the date-context block prepended to the first user message. */
export function claudeCodeCliDateContextBlock(date: string): WireObject {
  const text =
    '<system-reminder>\n' +
    'As you answer the user\'s questions, you can use the following context:\n' +
    '# currentDate\n' +
    `Today's date is ${date}.\n` +
    '\n' +
    '      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n' +
    '</system-reminder>\n\n'
  return { type: 'text', text }
}

/** System blocks prepended by the profile: billing header + persona. */
export function claudeCodeCliSystemBlocks(): WireObject[] {
  return [
    { type: 'text', text: CLAUDE_CODE_CLI_BILLING_TEXT },
    { type: 'text', text: CLAUDE_CODE_CLI_PERSONA_TEXT, cache_control: { ...CLAUDE_CODE_CLI_CACHE_CONTROL } },
  ]
}

/** `metadata.user_id` for the CLI profile: the CLI identity JSON string. */
export function claudeCodeCliUserId(identity: ClaudeCodeCliIdentity): string {
  return `{"device_id":"${identity.deviceId}","account_uuid":"${identity.accountUuid}","session_id":"${identity.sessionId}"}`
}

/** Beta list after managed-beta stripping for the CLI profile. */
export function claudeCodeCliBetas(body: Readonly<WireObject>): readonly string[] {
  const thinking = body['thinking']
  const thinkingType = typeof thinking === 'object' && thinking !== null ? (thinking as WireObject)['type'] : undefined
  const model = typeof body['model'] === 'string' ? body['model'] : ''
  const disabled = thinkingType === 'disabled'
  const haiku = model.includes('haiku')
  if (!disabled && !haiku) return CLAUDE_CODE_CLI_BETAS
  return CLAUDE_CODE_CLI_BETAS.filter((beta) => beta !== 'effort-2025-11-24')
}

/**
 * Provider registry of the OAuth login surfaces: wire constants (public
 * interface facts, cited by S3) and the provider-name normalization used
 * by the management callback ladder.
 */

/** Canonical OAuth provider ids used as session providers. */
export type OAuthProviderId =
  | 'anthropic'
  | 'codex'
  | 'antigravity'
  | 'devin'
  | 'kimi'
  | 'xai'
  | 'meta'

/** Claude (session provider `anthropic`). */
export const CLAUDE = {
  authorizeEndpoint: 'https://claude.ai/oauth/authorize',
  tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'http://localhost:54545/callback',
  scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  loopbackPort: 54545,
  profileEndpoint: 'https://api.anthropic.com/api/oauth/profile',
  rolesEndpoint: 'https://api.anthropic.com/api/oauth/claude_cli/roles',
  /** Refresh lead: 4 hours before expiry. */
  refreshLeadMs: 4 * 60 * 60_000,
} as const

/** Codex (session provider `codex`). */
export const CODEX = {
  authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid email profile offline_access',
  refreshScope: 'openid profile email',
  loopbackPort: 1455,
  deviceUsercodeEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/token',
  deviceVerificationUrl: 'https://auth.openai.com/codex/device',
  deviceExchangeRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  /** Refresh lead: 24 hours. */
  refreshLeadMs: 24 * 60 * 60_000,
} as const

/** Antigravity. */
export const ANTIGRAVITY = {
  authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  // Public installed-app constant, on-file with the vendor's CLI distribution.
  clientSecret: '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',
  redirectUri: 'http://localhost:51121/oauth-callback',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ] as readonly string[],
  loopbackPort: 51121,
  userinfoEndpoint: 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json',
  cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  /** Refresh lead: 30 minutes. */
  refreshLeadMs: 30 * 60_000,
} as const

/** Devin. */
export const DEVIN = {
  authorizeEndpoint: 'https://app.devin.ai/auth/cli/continue',
  tokenEndpoint: 'https://api.devin.ai/auth/cli/token',
  selfEndpoint: 'https://api.devin.ai/v3/self',
  sessionTokenPrefix: 'devin-session-token$',
  baseUrlAttribute: 'https://server.codeium.com',
} as const

/** Kimi device flow. */
export const KIMI = {
  deviceAuthorizationEndpoint: 'https://auth.kimi.com/api/oauth/device_authorization',
  tokenEndpoint: 'https://auth.kimi.com/api/oauth/token',
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
  deviceGrant: 'urn:ietf:params:oauth:grant-type:device_code',
  /** Refresh lead: 5 minutes. */
  refreshLeadMs: 5 * 60_000,
  /** Poll deadline: min(15 minutes, vendor expires_in). */
  deadlineMs: 15 * 60_000,
  intervalFloorMs: 5_000,
  statePrefix: 'kmi-',
} as const

/** xAI OIDC + device flow. */
export const XAI = {
  discoveryEndpoint: 'https://auth.x.ai/.well-known/openid-configuration',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  deviceScope: 'openid profile email offline_access grok-cli:access api:access',
  /** Refresh lead: 5 minutes. */
  refreshLeadMs: 5 * 60_000,
  /** Poll deadline: min(30 minutes, vendor expires_in). */
  deadlineMs: 30 * 60_000,
  intervalFloorMs: 5_000,
  statePrefix: 'xai-',
  /** Login-response fallback when the vendor omits expires_in. */
  expiresFallbackSeconds: 1800,
} as const

/** Meta device flow. */
export const META = {
  deviceAuthorizationEndpoint: 'https://auth.meta.com/oidc/device/authorization/',
  tokenEndpoint: 'https://auth.meta.com/oidc/device/token/',
  keyMintEndpoint: 'https://api.meta.ai/muse-code/key',
  clientId: '1031625952748946',
  userAgent: 'muse-code/1.0.2',
  /** Poll deadline: min(15 minutes, vendor expires_in). */
  deadlineMs: 15 * 60_000,
  intervalFloorMs: 5_000,
  statePrefix: 'meta-',
  /** Login-response fallback when the vendor omits expires_in. */
  expiresFallbackSeconds: 900,
} as const

/** Login waits at most 5 minutes for a callback. */
export const OAUTH_CALLBACK_WAIT_MS = 5 * 60_000

/** Callback handshake poll interval used by login waiters. */
export const OAUTH_CALLBACK_POLL_INTERVAL_MS = 500

/** Alias table applied after lowercasing; plugin ids pass through. */
const ALIASES: Readonly<Record<string, OAuthProviderId>> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  codex: 'codex',
  openai: 'codex',
  antigravity: 'antigravity',
  'anti-gravity': 'antigravity',
  devin: 'devin',
  cognition: 'devin',
  xai: 'xai',
  'x-ai': 'xai',
  'x.ai': 'xai',
  grok: 'xai',
  meta: 'meta',
  muse: 'meta',
  kimi: 'kimi',
}

const PLUGIN_ID_PATTERN = /^[a-z0-9-]+$/

export type NormalizedProvider =
  | { readonly ok: true; readonly provider: string }
  | { readonly ok: false }

/**
 * Normalizes a provider name: trims and lowercases, maps the documented
 * aliases to their canonical session provider, accepts plugin-shaped ids
 * `[a-z0-9-]+` verbatim, and rejects everything else
 * ("unsupported provider").
 */
export function normalizeProvider(raw: string): NormalizedProvider {
  const lowered = raw.trim().toLowerCase()
  const alias = Object.prototype.hasOwnProperty.call(ALIASES, lowered)
    ? ALIASES[lowered]
    : undefined
  if (alias !== undefined) return { ok: true, provider: alias }
  if (PLUGIN_ID_PATTERN.test(lowered)) return { ok: true, provider: lowered }
  return { ok: false }
}

/**
 * Public surface of @cpa-edge/auth: client key authentication, realtime
 * client secrets, management-plane authorization, OAuth code/device/refresh
 * flows, and the auth-file document model. Everything stateful flows
 * through the `Store` from `@cpa-edge/core`; runtimes own HTTP routing,
 * management endpoints and scheduling.
 */

export type {
  ClientAuthHeaders,
  ClientAuthFailure,
  ClientAuthInput,
  ClientAuthResult,
  ClientAuthSuccess,
  CredentialCandidate,
  CredentialSource,
  SafeModeDetection,
} from './api-keys'
export {
  detectSafeMode,
  extractBearerToken,
  extractCredentialCandidates,
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  normalizeApiKeys,
  SAFE_MODE_HEADER,
  SAFE_MODE_PROXY_BODY,
  safeModePageHtml,
  authenticateClientRequest,
  TEMPLATE_API_KEYS,
} from './api-keys'

export type { RealtimeAuthInput, RealtimeSecret, RealtimeSecretRegistry } from './realtime'
export {
  authenticateRealtimeRequest,
  DEFAULT_SECRET_LIFETIME_MS,
  InMemoryRealtimeSecretRegistry,
  INVALID_REALTIME_SECRET_BODY,
  MAX_SECRET_LIFETIME_MS,
  MIN_SECRET_LIFETIME_MS,
  REALTIME_SECRET_BYTES,
  REALTIME_SECRET_PREFIX,
  realtimeApiKeyErrorBody,
  realtimeServiceErrorBody,
  StoreRealtimeSecretRegistry,
} from './realtime'

export type {
  ClientAddressInput,
  ManagementAttemptEntry,
  ManagementAttemptsDocument,
  ManagementAuthConfig,
  ManagementAuthResult,
  ManagementRequestContext,
  ManagementRequestHeaders,
  PreparedManagementSecret,
} from './mgmt-auth'
export {
  INVALID_MANAGEMENT_KEY_BODY,
  prepareManagementSecretSync,
  isLocalIp,
  isParseableIp,
  looksLikeBcrypt,
  MANAGEMENT_BAN_DURATION_MS,
  MANAGEMENT_BAN_THRESHOLD,
  MANAGEMENT_BUILD_HEADER_NAMES,
  MANAGEMENT_SWEEP_INTERVAL_MS,
  MANAGEMENT_SWEEP_MAX_IDLE_MS,
  MGMT_ATTEMPTS_KEY,
  MGMT_ATTEMPTS_NAMESPACE,
  MISSING_MANAGEMENT_KEY_BODY,
  prepareManagementSecret,
  REMOTE_MANAGEMENT_DISABLED_BODY,
  REMOTE_MANAGEMENT_KEY_NOT_SET_BODY,
  resolveClientIp,
  verifyManagementSecret,
  ManagementAuthService,
} from './mgmt-auth'

export type {
  OAuthSessionDocument,
  RegisterOptions,
  RegisterResult,
} from './oauth-sessions'
export {
  isValidOauthState,
  OAuthSessionRegistry,
  OAUTH_SESSIONS_NAMESPACE,
  OAUTH_SESSION_COMPLETED_TTL_MS,
  OAUTH_SESSION_DEFAULT_ERROR,
  OAUTH_STATE_MAX_LENGTH,
  OAUTH_SESSION_PENDING_TTL_MS,
} from './oauth-sessions'

export type { AuthorizeUrlInput, DevinAuthorizeUrlInput, LoginServiceDeps, LoginUrlResult } from './oauth-login'
export {
  buildAntigravityAuthorizeUrl,
  buildClaudeAuthorizeUrl,
  buildCodexAuthorizeUrl,
  buildDevinAuthorizeUrl,
  FAILED_AUTHORIZATION_URL_BODY,
  FAILED_PKCE_BODY,
  FAILED_STATE_BODY,
  OAuthLoginService,
} from './oauth-login'

export type { CallbackParams, OAuthCallbackFile } from './oauth-callback'
export {
  consumeCallbackFile,
  OAuthCallbackService,
  OAUTH_CALLBACKS_NAMESPACE,
  OAUTH_SUCCESS_HTML,
  publishCallbackFile,
  storePublishCallback,
} from './oauth-callback'
export type { PublishCallbackFn } from './oauth-callback'

export type {
  AuthManagementVerdict,
  AuthPlane,
  AuthPlaneConfig,
  AuthPlaneDeps,
  AuthUrlProvider,
} from './plane'
export { createAuthPlane } from './plane'

export type {
  AuthFileSkipReason,
  LoadedAuthFile,
  ParseAuthFileResult,
} from './credential-docs'
export {
  antigravityFileName,
  AUTH_FILES_NAMESPACE,
  claudeFileName,
  codexFileName,
  deleteAuthFile,
  devinFileName,
  isRefreshableCredential,
  kimiFileName,
  listAuthFiles,
  MAX_CREDENTIAL_WEIGHT,
  metaFileName,
  metaDcaTokenOf,
  parseAuthFileDocument,
  refreshSecretOf,
  sanitizeFileToken,
  saveAuthFile,
  shortHash,
  vertexFileName,
  xaiFileName,
} from './credential-docs'

export type {
  ClaudeExchangeInput,
  CodexExchangeInput,
  DevinExchangeInput,
  ExchangeDeps,
  ExchangeResult,
  LoginWaiterDeps,
  LoginWaiterOutcome,
} from './token-exchange'
export {
  buildKimiCredential,
  buildMetaCredential,
  buildXaiCredential,
  exchangeAntigravityCode,
  exchangeClaudeCode,
  exchangeCodexCode,
  exchangeDevinCode,
  ExchangeError,
  runCodeLoginWaiter,
  splitCodeState,
} from './token-exchange'

export type {
  DeviceFlowDeps,
  DeviceLoginStart,
  DevicePollResult,
  PollDeviceDeps,
  PollDeviceInput,
  StartDeviceLoginInput,
} from './device-flows'
export {
  deviceDeadlineMs,
  pollCodexDeviceToken,
  pollKimiDeviceToken,
  pollMetaDeviceToken,
  pollXaiDeviceToken,
  startCodexDeviceLogin,
  startKimiDeviceLogin,
  startMetaDeviceLogin,
  startXaiDeviceLogin,
} from './device-flows'

export type {
  CredentialKind,
  RefreshDeps,
  RefreshOutcome,
  RefreshRegistryDocument,
  RefreshSchedulingInput,
} from './refresh'
export {
  isRefreshCredential,
  isUnauthorizedUpstreamError,
  MAX_CONCURRENT_REFRESHES,
  parseRetryAfterMs,
  REFRESH_ATTEMPT_TIMEOUT_MS,
  REFRESH_CHECK_INTERVAL_MS,
  REFRESH_FAILURE_BACKOFF_MS,
  REFRESH_INEFFECTIVE_BACKOFF_MS,
  REFRESH_LEADS_MS,
  REFRESH_PENDING_BACKOFF_MS,
  REFRESH_REGISTRY_NAMESPACE,
  RefreshRegistry,
  refreshAntigravityToken,
  refreshClaudeToken,
  refreshCodexToken,
  refreshCredential,
  refreshKimiToken,
  refreshMetaToken,
  refreshXaiToken,
  shouldRefresh,
  UnauthorizedRefresher,
} from './refresh'

export {
  ANTIGRAVITY,
  CLAUDE,
  CODEX,
  DEVIN,
  KIMI,
  META,
  normalizeProvider,
  OAUTH_CALLBACK_POLL_INTERVAL_MS,
  OAUTH_CALLBACK_WAIT_MS,
  XAI,
} from './providers'
export type { NormalizedProvider, OAuthProviderId } from './providers'

export {
  formatRfc3339,
  goDurationString,
  goJsonStringify,
  goQueryEscape,
  goValuesEncode,
  jsonStringifyOrdered,
  parseFormValues,
  parseGoUrl,
  parseQueryString,
  parseRfc3339Ms,
} from './wire'
export type {
  AuthResponse,
  Clock,
  FetchInit,
  FetchLike,
  SleepFn,
} from './types'
export {
  constantTimeEqual,
  decodeJwtPayload,
  generatePkcePair,
  randomHex,
  sha256Base64Url,
  sha256Hex,
  toBase64Url,
  toHex,
} from './crypto-util'
export { asPlainObject, readNumber, readObject, readString } from './types'

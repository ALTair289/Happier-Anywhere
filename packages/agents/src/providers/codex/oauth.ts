export const OPENAI_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_OAUTH_BASE_URL = 'https://auth.openai.com';
export const OPENAI_CODEX_OAUTH_AUTHORIZE_URL = `${OPENAI_CODEX_OAUTH_BASE_URL}/oauth/authorize`;
export const OPENAI_CODEX_OAUTH_TOKEN_URL = `${OPENAI_CODEX_OAUTH_BASE_URL}/oauth/token`;
export const OPENAI_CODEX_OAUTH_CALLBACK_URL = 'http://localhost:1455/auth/callback';
export const OPENAI_CODEX_OAUTH_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
] as const);
export const OPENAI_CODEX_OAUTH_SCOPE = OPENAI_CODEX_OAUTH_SCOPES.join(' ');
export const OPENAI_CODEX_DEVICE_USER_CODE_URL = `${OPENAI_CODEX_OAUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const OPENAI_CODEX_DEVICE_TOKEN_URL = `${OPENAI_CODEX_OAUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_CODEX_OAUTH_BASE_URL}/codex/device`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_OAUTH_BASE_URL}/deviceauth/callback`;

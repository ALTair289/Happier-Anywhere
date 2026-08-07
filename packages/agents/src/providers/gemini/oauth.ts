export const GEMINI_CLI_OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GEMINI_CLI_OAUTH_CLIENT_SECRET =
  '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';
export const GEMINI_CLI_OAUTH_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GEMINI_CLI_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GEMINI_CLI_OAUTH_CALLBACK_URL =
  'http://localhost:54545/oauth2callback';
export const GEMINI_CLI_OAUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const);

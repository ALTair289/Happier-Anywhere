import {
  GEMINI_CLI_OAUTH_AUTHORIZE_URL,
  GEMINI_CLI_OAUTH_CALLBACK_URL,
  GEMINI_CLI_OAUTH_CLIENT_ID,
  GEMINI_CLI_OAUTH_SCOPES,
} from '@happier-dev/agents';

export const GEMINI_OAUTH = Object.freeze({
  clientId: GEMINI_CLI_OAUTH_CLIENT_ID,
  authorizeUrl: GEMINI_CLI_OAUTH_AUTHORIZE_URL,
  defaultRedirectUri: GEMINI_CLI_OAUTH_CALLBACK_URL,
  scopes: GEMINI_CLI_OAUTH_SCOPES.join(' '),
});

export function buildGeminiAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    client_id: GEMINI_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: GEMINI_OAUTH.scopes,
    access_type: 'offline',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    prompt: 'consent',
  });
  return `${GEMINI_OAUTH.authorizeUrl}?${query.toString()}`;
}

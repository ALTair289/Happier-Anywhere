import {
  OPENAI_CODEX_OAUTH_AUTHORIZE_URL,
  OPENAI_CODEX_OAUTH_CALLBACK_URL,
  OPENAI_CODEX_OAUTH_CLIENT_ID,
  OPENAI_CODEX_OAUTH_SCOPE,
} from '@happier-dev/agents';

export const OPENAI_CODEX_OAUTH = Object.freeze({
  clientId: OPENAI_CODEX_OAUTH_CLIENT_ID,
  authorizeUrl: OPENAI_CODEX_OAUTH_AUTHORIZE_URL,
  defaultRedirectUri: OPENAI_CODEX_OAUTH_CALLBACK_URL,
  scope: OPENAI_CODEX_OAUTH_SCOPE,
});

export function buildOpenAiCodexAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_OAUTH.clientId,
    redirect_uri: params.redirectUri,
    scope: OPENAI_CODEX_OAUTH.scope,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: params.state,
  });
  return `${OPENAI_CODEX_OAUTH.authorizeUrl}?${query.toString()}`;
}

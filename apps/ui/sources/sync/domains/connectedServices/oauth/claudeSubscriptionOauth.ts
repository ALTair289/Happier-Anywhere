import {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CALLBACK_URL,
  CLAUDE_OAUTH_CLIENT_ID,
} from '@happier-dev/agents';

export const CLAUDE_SUBSCRIPTION_OAUTH = Object.freeze({
  clientId: CLAUDE_OAUTH_CLIENT_ID,
  authorizeUrl: CLAUDE_OAUTH_AUTHORIZE_URL,
  defaultRedirectUri: CLAUDE_OAUTH_CALLBACK_URL,
  scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
});

export function buildClaudeSubscriptionAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  // Claude.ai uses a slightly non-standard authorize flow where `code=true` triggers showing a code and redirect.
  const query = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_SUBSCRIPTION_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: CLAUDE_SUBSCRIPTION_OAUTH.scope,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  return `${CLAUDE_SUBSCRIPTION_OAUTH.authorizeUrl}?${query.toString()}`;
}

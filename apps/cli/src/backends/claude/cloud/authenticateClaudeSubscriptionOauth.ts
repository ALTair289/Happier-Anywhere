import { randomBytes } from 'node:crypto';

import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
} from '@happier-dev/agents';

import type { CloudConnectAuthenticateOptions } from '@/cloud/connectTypes';
import { generatePkceCodes } from '@/cloud/pkce';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';
import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';
import { promptInput } from '@/terminal/prompts/promptInput';
import { openBrowser } from '@/ui/openBrowser';
import { delay } from '@/utils/time';

export type ClaudeSubscriptionOauthTokens = Readonly<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  account?: {
    uuid?: string;
    email_address?: string;
  };
}>;

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPE = CLAUDE_SUBSCRIPTION_OAUTH_SCOPE;

function generateState(): string {
  return randomBytes(32).toString('hex');
}

export function buildClaudeSubscriptionAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: SCOPE,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  return `${CLAUDE_OAUTH_AUTHORIZE_URL}?${query.toString()}`;
}

export async function exchangeClaudeSubscriptionAuthorizationCodeForTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  state: string;
  fetcher?: typeof fetch;
}>): Promise<ClaudeSubscriptionOauthTokens> {
  const fetcher = params.fetcher ?? fetch;
  const response = await fetcher(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: params.verifier,
      state: params.state,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: response.status,
      statusText: response.statusText,
      body,
    }));
  }

  return (await response.json()) as ClaudeSubscriptionOauthTokens;
}

export async function authenticateClaudeSubscriptionOauth(
  opts?: CloudConnectAuthenticateOptions,
): Promise<ClaudeSubscriptionOauthTokens> {
  const timeoutMs =
    typeof opts?.timeoutSeconds === 'number' && Number.isFinite(opts.timeoutSeconds)
      ? Math.max(1, Math.trunc(opts.timeoutSeconds)) * 1000
      : undefined;

  const pkce = generatePkceCodes();
  const state = generateState();
  const authorizationUrl = buildClaudeSubscriptionAuthorizationUrl({
    redirectUri: REDIRECT_URI,
    state,
    challenge: pkce.challenge,
  });

  process.stdout.write('\nOpen this URL in a browser to authenticate:\n\n');
  process.stdout.write(`${authorizationUrl}\n\n`);
  process.stdout.write('After login, paste the final redirected URL (or the "code#state" string) here.\n\n');

  if (!opts?.noOpen) {
    try {
      await openBrowser(authorizationUrl);
    } catch {
      // Non-fatal: the user can still copy/paste the URL and complete auth manually.
    }
  }

  const pastedPromise = promptInput('Paste redirect URL: ');
  const pasted = timeoutMs
    ? await Promise.race([
      pastedPromise,
      delay(timeoutMs).then(() => {
        throw new Error('Authentication timed out');
      }),
    ])
    : await pastedPromise;

  const parsed = parseOauthRedirectPaste({ pasted });
  if (!parsed.ok) {
    throw new Error(`Invalid OAuth redirect paste (${parsed.error})`);
  }
  if (parsed.state !== state) {
    throw new Error('OAuth state mismatch');
  }

  return await exchangeClaudeSubscriptionAuthorizationCodeForTokens({
    code: parsed.code,
    verifier: pkce.verifier,
    redirectUri: REDIRECT_URI,
    state,
  });
}

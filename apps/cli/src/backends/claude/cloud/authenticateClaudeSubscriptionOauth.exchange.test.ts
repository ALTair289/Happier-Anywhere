import { describe, expect, it } from 'vitest';
import { CLAUDE_OAUTH_AUTHORIZE_URL } from '@happier-dev/agents';

import {
  buildClaudeSubscriptionAuthorizationUrl,
  exchangeClaudeSubscriptionAuthorizationCodeForTokens,
} from './authenticateClaudeSubscriptionOauth';

describe('exchangeClaudeSubscriptionAuthorizationCodeForTokens', () => {
  it('uses Claude Code current authorization endpoint', () => {
    expect(buildClaudeSubscriptionAuthorizationUrl({
      redirectUri: 'https://platform.claude.com/oauth/code/callback',
      state: 'state',
      challenge: 'challenge',
    })).toMatch(new RegExp(`^${CLAUDE_OAUTH_AUTHORIZE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?`));
  });

  it('posts JSON to Claude Code current token endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];

    const fetcher = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'user:inference',
        account: { uuid: 'acct', email_address: 'user@example.com' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    const tokens = await exchangeClaudeSubscriptionAuthorizationCodeForTokens({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:54545/oauth2callback',
      state: 'state',
      fetcher,
    });

    expect(tokens.access_token).toBe('access');
    expect(tokens.refresh_token).toBe('refresh');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(calls[0]!.init.method).toBe('POST');
    expect(String(calls[0]!.init.headers && (calls[0]!.init.headers as any)['Content-Type'])).toMatch(/application\/json/i);
    expect(typeof calls[0]!.init.body).toBe('string');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: 'http://localhost:54545/oauth2callback',
      state: 'state',
    });
  });

  it('redacts token exchange failure response bodies while preserving status and provider code', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'refresh token claude-secret-refresh was rejected',
      access_token: 'claude-secret-access',
      refresh_token: 'claude-secret-refresh',
    }), { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } });

    let caught: unknown = null;
    try {
      await exchangeClaudeSubscriptionAuthorizationCodeForTokens({
        code: 'code',
        verifier: 'verifier',
        redirectUri: 'http://localhost:54545/oauth2callback',
        state: 'state',
        fetcher,
      });
    } catch (error) {
      caught = error;
    }

    expect(String(caught)).toContain('Token exchange failed (400): invalid_grant');
    expect(String(caught)).not.toMatch(/claude-secret-refresh|claude-secret-access|error_description/);
  });
});

import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@happier-dev/agents';

import { buildClaudeSubscriptionAuthorizationUrl, CLAUDE_SUBSCRIPTION_OAUTH } from './claudeSubscriptionOauth';

describe('claudeSubscriptionOauth', () => {
  it('uses Claude Code-compatible OAuth scopes with the console callback redirect URI', () => {
    const url = buildClaudeSubscriptionAuthorizationUrl({
      redirectUri: CLAUDE_SUBSCRIPTION_OAUTH.defaultRedirectUri,
      state: 'st1',
      challenge: 'ch1',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://claude.com');
    expect(parsed.pathname).toBe('/cai/oauth/authorize');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(parsed.searchParams.get('scope')).toBe(CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE);
    expect(parsed.searchParams.get('scope')?.split(' ')).toContain('org:create_api_key');
  });
});

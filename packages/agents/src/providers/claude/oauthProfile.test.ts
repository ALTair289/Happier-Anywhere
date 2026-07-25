import { describe, expect, it } from 'vitest';

import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
  normalizeClaudeOauthProfileEntitlement,
} from './oauthProfile';

describe('normalizeClaudeOauthProfileEntitlement', () => {
  it('uses Claude Code current OAuth token endpoint', () => {
    expect(CLAUDE_OAUTH_AUTHORIZE_URL).toBe('https://platform.claude.com/oauth/authorize');
    expect(CLAUDE_OAUTH_TOKEN_URL).toBe('https://platform.claude.com/v1/oauth/token');
  });

  it('projects only the Claude plan facts needed by native credential materialization', () => {
    expect(normalizeClaudeOauthProfileEntitlement({
      account: {
        email: 'private@example.test',
        has_claude_max: true,
        uuid: 'private-account-id',
      },
      organization: {
        organization_type: 'claude_max',
        rate_limit_tier: 'default_claude_max_20x',
        subscription_status: 'active',
      },
    })).toEqual({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
  });

  it('returns null for unknown or malformed entitlement data', () => {
    expect(normalizeClaudeOauthProfileEntitlement({ organization: { organization_type: 'workspace' } })).toBeNull();
    expect(normalizeClaudeOauthProfileEntitlement(null)).toBeNull();
  });
});

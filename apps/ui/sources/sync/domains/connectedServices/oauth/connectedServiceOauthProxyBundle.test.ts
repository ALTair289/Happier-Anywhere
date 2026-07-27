import { describe, expect, it } from 'vitest';

import { buildOauthRecordFromProxyPayload } from './connectedServiceOauthProxyBundle';

describe('buildOauthRecordFromProxyPayload', () => {
  it('retains sanitized provider entitlement metadata in the canonical OAuth record', () => {
    const record = buildOauthRecordFromProxyPayload({
      now: 1_700_000_000_000,
      serviceId: 'claude-subscription',
      profileId: 'claude-max',
      payload: {
        serviceId: 'claude-subscription',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerEmail: 'user@example.test',
        providerAccountId: 'account-id',
        expiresAt: 1_700_003_600_000,
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
          },
        },
      },
    });

    expect(record.kind).toBe('oauth');
    if (record.kind !== 'oauth') throw new Error('expected oauth record');
    expect(record.oauth.raw).toEqual({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
  });
});

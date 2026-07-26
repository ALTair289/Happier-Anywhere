import { describe, expect, it } from 'vitest';

import {
  readClaudeOauthAccountIdentity,
  reconcileClaudeAccountScopedRootConfig,
} from './claudeRootConfig';

describe('readClaudeOauthAccountIdentity', () => {
  it('reads Claude accountUuid identity from the sanitized oauthAccount projection', () => {
    expect(readClaudeOauthAccountIdentity({
      accountUuid: 'account-uuid',
      emailAddress: 'member@example.com',
      organizationUuid: 'org-uuid',
    })).toEqual({
      email: 'member@example.com',
      accountId: 'account-uuid',
    });
  });
});

describe('reconcileClaudeAccountScopedRootConfig', () => {
  it('drops predecessor entitlement state while preserving workspace state on exact credential replacement', () => {
    expect(reconcileClaudeAccountScopedRootConfig({
      rootConfig: {
        oauthAccount: { emailAddress: 'old@example.test', accountUuid: 'old-account' },
        modelAccessCache: [{ value: 'claude-fable-5', description: 'Requires usage credits' }],
        additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]' }],
        cachedExtraUsageDisabledReason: 'org_level_disabled',
        projects: { '/repo': { hasTrustDialogAccepted: true } },
      },
      preserveExistingAccountState: false,
      providerAccountId: 'new-account',
      providerEmail: 'new@example.test',
    })).toEqual({
      oauthAccount: { accountUuid: 'new-account', emailAddress: 'new@example.test' },
      projects: { '/repo': { hasTrustDialogAccepted: true } },
    });
  });

  it('preserves current provider-owned state for the exact same credential provenance', () => {
    const rootConfig = {
      oauthAccount: { emailAddress: 'current@example.test' },
      additionalModelOptionsCache: [{ value: 'claude-fable-5' }],
    };
    expect(reconcileClaudeAccountScopedRootConfig({
      rootConfig,
      preserveExistingAccountState: true,
      providerAccountId: 'current-account',
      providerEmail: 'current@example.test',
    })).toEqual(rootConfig);
  });
});

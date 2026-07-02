import { describe, expect, it } from 'vitest';

import { readClaudeOauthAccountIdentity } from './claudeRootConfig';

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

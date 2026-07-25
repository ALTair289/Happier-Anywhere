import { describe, expect, it } from 'vitest';

import { AccountProfileSchema } from './profile';

describe('AccountProfileSchema connectedServicesV2', () => {
  it('defaults connectedServicesV2 to an empty array', () => {
    const parsed = AccountProfileSchema.parse({ id: 'acct' });
    expect(parsed.connectedServicesV2).toEqual([]);
    expect(parsed.connectedServiceCredentialRevisionsV1).toEqual([]);
  });

  it('parses exact opaque credential revisions without requiring them from supported older projections', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
      }],
    });

    expect(parsed.connectedServiceCredentialRevisionsV1).toEqual([{
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    }]);
    expect(AccountProfileSchema.safeParse({
      id: 'acct',
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'not-a-revision',
      }],
    }).success).toBe(false);
  });

  it('accepts connectedServicesV2 service + profile projections', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [
            {
              profileId: 'work',
              status: 'needs_reauth',
              kind: 'oauth',
              providerEmail: 'a@b.com',
              expiresAt: 1,
              health: {
                v: 1,
                status: 'needs_reauth',
                reconnectRequired: true,
                lastRefreshFailureKind: 'invalid_grant',
                lastRefreshFailureAt: 2,
              },
            },
          ],
        },
      ],
    });
    expect(parsed.connectedServicesV2[0]?.serviceId).toBe('openai-codex');
    expect(parsed.connectedServicesV2[0]?.profiles[0]?.profileId).toBe('work');
    expect(parsed.connectedServicesV2[0]?.profiles[0]?.health?.reconnectRequired).toBe(true);
    expect(JSON.stringify(parsed.connectedServicesV2)).not.toContain('secret');
  });

  it('accepts connectedServicesV2 account group projections without secrets', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [
            { profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'a@b.com', expiresAt: 1 },
          ],
          groups: [
            {
              groupId: 'codex-main',
              displayName: 'Codex main',
              activeProfileId: 'work',
              generation: 2,
              memberProfileIds: ['work', 'personal'],
            },
          ],
        },
      ],
    });

    expect(parsed.connectedServicesV2[0]?.groups?.[0]).toEqual({
      groupId: 'codex-main',
      displayName: 'Codex main',
      activeProfileId: 'work',
      generation: 2,
      memberProfileIds: ['work', 'personal'],
    });
    expect((parsed.connectedServicesV2[0]?.groups?.[0] as Record<string, unknown>).credential).toBeUndefined();
  });
});

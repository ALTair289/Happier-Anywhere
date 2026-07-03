import { describe, expect, it } from 'vitest';

import { readConnectedServiceCredentialUpdateRefsFromAccountUpdate } from './readConnectedServiceCredentialUpdateRefsFromAccountUpdate';

describe('readConnectedServiceCredentialUpdateRefsFromAccountUpdate', () => {
  it('returns connected profile refs from account connected-service updates', () => {
    expect(readConnectedServiceCredentialUpdateRefsFromAccountUpdate({
      body: {
        t: 'update-account',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [
              { profileId: 'work', status: 'connected' },
              { profileId: 'expired', status: 'needs_reauth' },
            ],
          },
          {
            serviceId: 'claude-subscription',
            profiles: [{ profileId: 'claude-work', status: 'connected' }],
          },
        ],
      },
    })).toEqual([
      { serviceId: 'openai-codex', profileId: 'work' },
      { serviceId: 'claude-subscription', profileId: 'claude-work' },
    ]);
  });

  it('returns retryable refresh-failure profile refs because they remain usable', () => {
    expect(readConnectedServiceCredentialUpdateRefsFromAccountUpdate({
      body: {
        t: 'update-account',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [
              { profileId: 'retry', status: 'refresh_failed_retryable' },
              { profileId: 'refreshing', status: 'refreshing' },
              { profileId: 'expired', status: 'needs_reauth' },
            ],
          },
        ],
      },
    })).toEqual([
      { serviceId: 'openai-codex', profileId: 'retry' },
      { serviceId: 'openai-codex', profileId: 'refreshing' },
    ]);
  });

  it('ignores non-account updates and malformed connected-service entries', () => {
    expect(readConnectedServiceCredentialUpdateRefsFromAccountUpdate({
      body: {
        t: 'update-session',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected' }],
          },
        ],
      },
    })).toEqual([]);
    expect(readConnectedServiceCredentialUpdateRefsFromAccountUpdate({
      body: {
        t: 'update-account',
        connectedServicesV2: [
          { serviceId: 'not-a-known-service', profiles: [{ profileId: 'work', status: 'connected' }] },
          { serviceId: 'openai-codex', profiles: [{ profileId: '', status: 'connected' }] },
        ],
      },
    })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { agent } from './index';

describe('Claude connected-service credential lifecycle descriptor', () => {
  it('advertises shared-group live soft switching without claiming in-turn exact runtime identity', async () => {
    await expect(agent.getConnectedServiceCredentialLifecycleDescriptor()).resolves.toMatchObject({
      providerId: 'claude',
      serviceIds: expect.arrayContaining(['claude-subscription', 'anthropic']),
      spawnPreflightOauthRefresh: { mode: 'force' },
      refreshedCredentialApplication: { mode: 'no_restart_required' },
      sameAccountFanoutStrategy: 'shared_group_auth_surface',
      predictiveSoftSwitch: {
        mode: 'supported',
        liveSessionRequirement: {
          kind: 'shared_group_auth_surface',
          serviceIds: ['claude-subscription'],
          authEnvKey: 'CLAUDE_CONFIG_DIR',
          authEnvSubpath: ['claude-config'],
        },
      },
      runtimeAuthApply: {
        directLiveHotAuth: {
          supportsInTurnApply: false,
          requiresExactRuntimeIdentity: false,
          refreshSelectionResync: 'not_applicable',
          authMode: {
            kind: 'provider_owned',
            name: 'claude_shared_group_auth_surface',
          },
        },
      },
    });
  });
});

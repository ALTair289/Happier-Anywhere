import { describe, expect, it } from 'vitest';

import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { canonicalizeTargetSelectionsForRematerialization } from './rematerialization';

describe('canonicalizeTargetSelectionsForRematerialization', () => {
  it('rewrites a stale group target selection and credential binding as one canonical target', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const staleSelection = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'claude',
      activeProfileId: 'limited',
      fallbackProfileId: 'healthy',
      generation: 9,
    };
    const serializedSelection = serializeConnectedServiceChildSelections(
      new Map([[staleSelection.serviceId, staleSelection]]),
    );
    if (!serializedSelection) throw new Error('fixture selection must serialize');

    registry.registerTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'limited',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializedSelection,
      },
      materializationKey: 'csm_test',
    });
    const target = registry.listRefreshTargets()[0];
    if (!target) throw new Error('fixture target must be refreshable');

    const canonical = await canonicalizeTargetSelectionsForRematerialization({
      target,
      resolveCanonicalGroupState: async () => ({
        activeProfileId: 'healthy',
        generation: 10,
      }),
    });

    expect(canonical?.selectionsByServiceId.get('claude-subscription')).toMatchObject({
      activeProfileId: 'healthy',
      generation: 10,
    });
    expect(canonical?.bindings).toContainEqual({
      serviceId: 'claude-subscription',
      profileId: 'healthy',
    });
  });

});

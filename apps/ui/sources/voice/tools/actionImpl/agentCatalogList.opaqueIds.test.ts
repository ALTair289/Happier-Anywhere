import { afterEach, describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
  resetDynamicModelProbeCacheForTests,
  writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';

import { listAgentModelsForVoiceTool } from './agentCatalogList';

describe('listAgentModelsForVoiceTool opaque identifiers', () => {
  afterEach(() => resetDynamicModelProbeCacheForTests());

  it('does not collapse distinct nonblank model identifiers by trimming', async () => {
    const machineId = 'opaque-model-test-machine';
    const serverId = getActiveServerSnapshot().serverId || null;
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'cursor' });
    const cacheKey = buildDynamicModelProbeCacheKey({ machineId, targetKey, serverId, cwd: null });
    expect(cacheKey).toBeTruthy();
    writeDynamicModelProbeCacheSuccess(cacheKey!, {
      availableModels: [
        { id: 'model-a', name: 'Plain' },
        { id: ' model-a ', name: 'Spaced' },
      ],
      supportsFreeform: false,
    });

    const result = await listAgentModelsForVoiceTool({ agentId: 'cursor', machineId }) as {
      items: readonly { modelId: string }[];
    };

    expect(result.items.map((item) => item.modelId)).toEqual([
      'default',
      'model-a',
      ' model-a ',
    ]);
  });
});

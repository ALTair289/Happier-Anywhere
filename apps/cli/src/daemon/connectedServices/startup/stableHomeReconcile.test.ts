import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { buildDefaultConnectedServiceCredentialLifecycleDescriptor } from '../credentials/lifecycleTypes';
import { reconcileConnectedServiceStableHomes } from './stableHomeReconcile';

const api = {} as unknown as ApiClient;
const credentials = { token: 't', encryption: { type: 'none' } } as unknown as Credentials;

describe('reconcileConnectedServiceStableHomes', () => {
  it('iterates providers via the descriptor hook and aggregates results, skipping providers without the hook', async () => {
    const reconcileStableHomesAtStartup = vi.fn(async () => ({ scanned: 2, rewritten: 1 }));
    const resolveLifecycleDescriptor = vi.fn(async (agentId: 'codex' | 'claude') => {
      const base = buildDefaultConnectedServiceCredentialLifecycleDescriptor(agentId);
      if (agentId === 'codex') {
        return { ...base, materializedHomeMaintenance: { reconcileStableHomesAtStartup } };
      }
      return base; // claude has no reconcile hook here
    });

    const result = await reconcileConnectedServiceStableHomes({
      activeServerDir: '/srv',
      api,
      credentials,
      now: () => 1_000,
      agentIds: ['codex', 'claude'],
      resolveLifecycleDescriptor: resolveLifecycleDescriptor as never,
    });

    expect(result).toEqual({ scanned: 2, rewritten: 1 });
    expect(reconcileStableHomesAtStartup).toHaveBeenCalledTimes(1);
    expect(reconcileStableHomesAtStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        activeServerDir: '/srv',
        now: 1_000,
        resolveStoreCredentialRecordForProfile: expect.any(Function),
      }),
    );
  });

  it('continues past a provider hook that throws', async () => {
    const resolveLifecycleDescriptor = vi.fn(async (agentId: 'codex' | 'gemini') => {
      const base = buildDefaultConnectedServiceCredentialLifecycleDescriptor(agentId);
      return {
        ...base,
        materializedHomeMaintenance: {
          reconcileStableHomesAtStartup: agentId === 'codex'
            ? vi.fn(async () => { throw new Error('boom'); })
            : vi.fn(async () => ({ scanned: 3, rewritten: 0 })),
        },
      };
    });

    const result = await reconcileConnectedServiceStableHomes({
      activeServerDir: '/srv',
      api,
      credentials,
      agentIds: ['codex', 'gemini'],
      resolveLifecycleDescriptor: resolveLifecycleDescriptor as never,
    });

    expect(result).toEqual({ scanned: 3, rewritten: 0 });
  });
});

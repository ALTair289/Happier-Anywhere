import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { AGENTS, resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '../credentials/lifecycleTypes';
import { readCredentialForRefresh } from '../refresh/credentialStore';

type ResolveLifecycleDescriptor = (
  agentId: CatalogAgentId,
) => Promise<ConnectedServiceCredentialLifecycleDescriptor>;

export type ConnectedServiceStableHomeReconcileRun = Readonly<{
  scanned: number;
  rewritten: number;
}>;

/**
 * Run every connected-service provider's stable-home reconcile once (triage #4 systemic leg). The
 * owner is provider-agnostic: it iterates the catalog providers and consumes each descriptor's
 * `materializedHomeMaintenance.reconcileStableHomesAtStartup` hook — the SAME provider-home-
 * maintenance surface leg 2 (RR-9) established — supplying the daemon-owned store-record resolver.
 */
export async function reconcileConnectedServiceStableHomes(input: Readonly<{
  activeServerDir: string;
  api: ApiClient;
  credentials: Credentials;
  now?: () => number;
  agentIds?: readonly CatalogAgentId[];
  resolveLifecycleDescriptor?: ResolveLifecycleDescriptor;
}>): Promise<ConnectedServiceStableHomeReconcileRun> {
  const now = (input.now ?? (() => Date.now()))();
  const resolveDescriptor = input.resolveLifecycleDescriptor ?? resolveConnectedServiceCredentialLifecycleDescriptor;
  const agentIds = input.agentIds ?? (Object.keys(AGENTS) as CatalogAgentId[]);

  const resolveStoreCredentialRecordForProfile = async (
    binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
  ) => {
    const source = await readCredentialForRefresh({
      api: input.api,
      credentials: input.credentials,
      binding,
    });
    return source?.record ?? null;
  };

  let scanned = 0;
  let rewritten = 0;
  for (const agentId of agentIds) {
    const descriptor = await resolveDescriptor(agentId);
    const reconcile = descriptor.materializedHomeMaintenance?.reconcileStableHomesAtStartup;
    if (!reconcile) continue;
    try {
      const result = await reconcile({
        activeServerDir: input.activeServerDir,
        now,
        resolveStoreCredentialRecordForProfile,
      });
      scanned += result.scanned;
      rewritten += result.rewritten;
    } catch (error) {
      logger.debug('[DAEMON RUN] Stable-home reconcile failed for provider', { agentId, error });
    }
  }
  return { scanned, rewritten };
}

export type ConnectedServiceStableHomeReconcileSchedulerHandle = Readonly<{
  stop: () => void;
}>;

/**
 * Runs the stable-home reconcile once at daemon startup and then on a bounded cadence. Stable homes
 * drift slowly (they are not refresh-target bound), so the cadence is coarse; the initial pass is
 * what heals historical poison on the current boot.
 */
export function startConnectedServiceStableHomeReconcileScheduler(input: Readonly<{
  activeServerDir: string;
  api: ApiClient;
  credentials: Credentials;
  intervalMs: number;
  onError?: (error: unknown) => void;
}>): ConnectedServiceStableHomeReconcileSchedulerHandle {
  const runOnce = () => {
    void reconcileConnectedServiceStableHomes({
      activeServerDir: input.activeServerDir,
      api: input.api,
      credentials: input.credentials,
    }).catch((error) => input.onError?.(error));
  };

  runOnce();
  const timer = setInterval(runOnce, Math.max(60_000, Math.trunc(input.intervalMs))) as unknown as {
    unref?: () => void;
  } & NodeJS.Timeout;
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}

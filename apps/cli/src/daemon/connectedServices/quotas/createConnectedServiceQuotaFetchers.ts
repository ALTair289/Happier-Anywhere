import type { ConnectedServiceQuotaFetcher, ConnectedServiceQuotaFetcherDescriptor } from './types';

import { getConnectedServiceQuotaFetcherDescriptors } from '@/backends/catalog';

function parsePositiveIntEnv(raw: string | undefined, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

export function createConnectedServiceQuotaFetchers(
  env: NodeJS.ProcessEnv,
  descriptors: ReadonlyArray<ConnectedServiceQuotaFetcherDescriptor> = getConnectedServiceQuotaFetcherDescriptors(),
): Array<ConnectedServiceQuotaFetcher> {
  const staleAfterMs = parsePositiveIntEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS, 30 * 60_000, {
    min: 5_000,
    max: 24 * 60 * 60_000,
  });

  return descriptors.map((descriptor) => descriptor.loadQuota({ env, staleAfterMs }));
}

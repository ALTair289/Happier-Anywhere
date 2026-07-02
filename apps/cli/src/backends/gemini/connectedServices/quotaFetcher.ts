import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';
import type { ConnectedServiceQuotaFetcher, ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';

const GEMINI_QUOTA_STALE_AFTER_MS = 5 * 60_000;

/**
 * X7 — "connected but quota unknown" placeholder for Gemini.
 *
 * The daemon-side Gemini quota fetcher cannot determine quota independently
 * (quota is surfaced via the runtime auth adapter's probeQuota hook, which
 * requires live API credentials at session-spawn time). Rather than returning
 * null — which produces no display at all — this fetcher returns a snapshot
 * with a quota_unknown placeholder meter so the UI can show "quota unavailable"
 * instead of a blank.
 *
 * This fetcher is intentionally minimal; richer quota data comes from the
 * runtime auth adapter (createGeminiConnectedServiceRuntimeAuthAdapter).
 */
function buildQuotaUnknownMeter(): ConnectedServiceQuotaMeterV1 {
  return {
    meterId: 'quota_unknown',
    label: 'Quota',
    used: null,
    limit: null,
    unit: 'unknown',
    utilizationPct: null,
    resetsAt: null,
    status: 'unavailable',
    details: { code: 'quota_unknown' },
  };
}

export function createGeminiQuotaFetcher(): ConnectedServiceQuotaFetcher {
  return {
    serviceId: 'gemini',
    fetch: async ({ record, now }) => ({
      v: 1,
      serviceId: record.serviceId,
      profileId: record.profileId,
      fetchedAt: now,
      staleAfterMs: GEMINI_QUOTA_STALE_AFTER_MS,
      planLabel: null,
      accountLabel: null,
      meters: [buildQuotaUnknownMeter()],
    }),
  };
}

export const geminiQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = {
  loadQuota: () => createGeminiQuotaFetcher(),
};

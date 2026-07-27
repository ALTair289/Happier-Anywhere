import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createProviderAccountUsageStore } from '../../accountUsage/store';
import { recordFetchedQuotaSnapshotAsAccountUsage } from './recordFetchedQuotaSnapshotAsAccountUsage';

describe('recordFetchedQuotaSnapshotAsAccountUsage', () => {
  it('acknowledges an identical poll without persisting or notifying policy twice', async () => {
    const store = createProviderAccountUsageStore();
    const recordInBandSnapshot = vi.fn(async () => ({
      status: 'enqueued' as const,
      enqueue: 'accepted' as const,
    }));
    const handleAccountUsageChanged = vi.fn(async () => {});
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_live_codex',
      planLabel: null,
      accountLabel: null,
      source: 'background_fetch',
      confidence: 'exact',
      meters: [],
    };
    const context = {
      accountUsageStore: store,
      accountUsagePersistence: { recordInBandSnapshot },
      quotaFingerprintHmacKey: new Uint8Array(32),
      persistQuotaSnapshotWithServerWork: vi.fn(async () => {}),
      handleAccountUsageChanged,
    };
    const input = {
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      snapshot,
      now: 1_000,
      sourceProviderAccountId: 'acct_live_codex',
      groupTargets: [{
        sessionId: 'sess_connected',
        serviceId: 'openai-codex' as const,
        groupId: 'main',
        activeProfileId: 'primary',
        groupGeneration: 7,
      }],
    };

    await recordFetchedQuotaSnapshotAsAccountUsage(context, input);
    await recordFetchedQuotaSnapshotAsAccountUsage(context, input);

    expect(recordInBandSnapshot).toHaveBeenCalledOnce();
    expect(handleAccountUsageChanged).toHaveBeenCalledOnce();
  });
});

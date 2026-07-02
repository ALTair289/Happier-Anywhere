import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetProviderAccountUsageSnapshotCache,
  readProviderAccountUsageSnapshotFromCache,
  subscribeProviderAccountUsageSnapshotCache,
  writeProviderAccountUsageSnapshotToCache,
} from './cache';

function usageSnapshot(params: Readonly<{
  accountSubjectId?: string;
  fetchedAtMs: number;
}>): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: params.accountSubjectId ?? 'provider-account-1',
    subjectKind: 'account',
    quotaScope: 'account',
  } as const;
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: params.fetchedAtMs,
    fetchedAtMs: params.fetchedAtMs,
    staleAfterMs: 60_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'Provider account',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 55,
      limit: 100,
      unit: 'count',
      utilizationPct: null,
      remainingPct: null,
      resetsAt: null,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
  });
}

describe('provider account usage snapshot cache', () => {
  beforeEach(() => {
    __resetProviderAccountUsageSnapshotCache();
  });

  it('ignores older writes for the same record and does not notify subscribers', () => {
    const credentialScope = 'account:one';
    const older = usageSnapshot({ fetchedAtMs: 1_000 });
    const newer = usageSnapshot({ fetchedAtMs: 2_000 });
    const onChange = vi.fn();
    const unsubscribe = subscribeProviderAccountUsageSnapshotCache({ credentialScope }, onChange);

    writeProviderAccountUsageSnapshotToCache({ credentialScope, snapshot: newer });
    expect(onChange).toHaveBeenCalledTimes(1);

    writeProviderAccountUsageSnapshotToCache({ credentialScope, snapshot: older });

    expect(readProviderAccountUsageSnapshotFromCache({
      credentialScope,
      recordId: newer.recordId,
    })).toBe(newer);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

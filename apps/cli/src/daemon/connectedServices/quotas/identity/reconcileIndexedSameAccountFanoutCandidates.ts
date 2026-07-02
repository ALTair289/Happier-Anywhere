import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveRuntimeAccountIdentityFanoutMatch } from './resolveRuntimeAccountIdentityFanoutMatch';
import type {
  ReconciledRuntimeAccountIdentityEntry,
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityProbeResult,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
} from './runtimeAccountIdentityTypes';

export type RuntimeAccountIdentityReader = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  expectedGroupGeneration: number | null;
}>) => Promise<RuntimeAccountIdentityProbeResult>;

type SameAccountFanoutDiagnostic = Readonly<{
  event: 'quota_work_deferred' | 'quota_work_suppressed';
  phase: 'same_account_fanout';
  reason: string;
  retryAfterMs?: number;
  sessionId?: string;
  expectedProviderAccountId?: string | null;
  actualProviderAccountId?: string | null;
  expectedProfileId?: string;
  actualProfileId?: string | null;
  expectedGroupId?: string;
  actualGroupId?: string | null;
  expectedGroupGeneration?: number | null;
  actualGroupGeneration?: number | null;
}>;

function recordSuppression(
  recordDiagnostic: ((event: SameAccountFanoutDiagnostic) => void) | undefined,
  input: Readonly<{
    reason: string;
    sessionId?: string;
    expectedProviderAccountId?: string | null;
    actualProviderAccountId?: string | null;
    expectedProfileId?: string;
    actualProfileId?: string | null;
    expectedGroupId?: string;
    actualGroupId?: string | null;
    expectedGroupGeneration?: number | null;
    actualGroupGeneration?: number | null;
  }>,
): void {
  recordDiagnostic?.({
    event: 'quota_work_suppressed',
    phase: 'same_account_fanout',
    ...input,
  });
}

export async function reconcileIndexedSameAccountFanoutCandidates(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  providerAccountId: string;
  indexedCandidates: ReadonlyArray<RuntimeAccountIdentityEntry>;
  readRuntimeAccountIdentity?: RuntimeAccountIdentityReader | null;
  now: () => number;
  recordRuntimeAccountIdentity: (entry: RuntimeAccountIdentityRecordInput) => RuntimeAccountIdentityRecordResult;
  invalidateRuntimeAccountIdentity: (sessionId: string) => void;
  recordDiagnostic?: (event: SameAccountFanoutDiagnostic) => void;
}>): Promise<Array<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry>> {
  if (!input.readRuntimeAccountIdentity || input.indexedCandidates.length === 0) {
    return [...input.indexedCandidates];
  }

  const reconciled: Array<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry> = [];
  for (const candidate of input.indexedCandidates) {
    let result: RuntimeAccountIdentityProbeResult;
    try {
      result = await input.readRuntimeAccountIdentity({
        sessionId: candidate.sessionId,
        serviceId: candidate.serviceId,
        groupId: candidate.groupId ?? input.groupId,
        profileId: candidate.profileId,
        expectedGroupGeneration: candidate.groupGeneration,
      });
    } catch {
      recordSuppression(input.recordDiagnostic, {
        reason: 'runtime_identity_probe_missing_exact_identity',
        sessionId: candidate.sessionId,
        expectedProviderAccountId: input.providerAccountId,
        expectedProfileId: candidate.profileId,
        actualProfileId: candidate.profileId,
        expectedGroupId: candidate.groupId ?? input.groupId,
        actualGroupId: candidate.groupId ?? input.groupId,
        expectedGroupGeneration: candidate.groupGeneration,
        actualGroupGeneration: candidate.groupGeneration,
      });
      input.invalidateRuntimeAccountIdentity(candidate.sessionId);
      continue;
    }

    const match = resolveRuntimeAccountIdentityFanoutMatch({
      strategy: 'provider_account_id',
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId: input.providerAccountId,
      candidate,
      result,
      observedAtMs: input.now(),
    });
    if (match.status === 'suppressed') {
      recordSuppression(input.recordDiagnostic, {
        reason: match.reason,
        ...match.diagnostic,
      });
      input.invalidateRuntimeAccountIdentity(candidate.sessionId);
      continue;
    }
    if (match.staleExpectedStateReconciled) {
      recordSuppression(input.recordDiagnostic, {
        reason: 'runtime_identity_probe_stale_expected_state_reconciled',
      });
    }
    input.recordRuntimeAccountIdentity(match.entry);
    reconciled.push(match.entry);
  }
  return reconciled;
}

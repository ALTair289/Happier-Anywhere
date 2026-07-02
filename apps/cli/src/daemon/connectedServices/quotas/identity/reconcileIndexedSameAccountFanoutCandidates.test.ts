import { describe, expect, it, vi } from 'vitest';

import { reconcileIndexedSameAccountFanoutCandidates } from './reconcileIndexedSameAccountFanoutCandidates';
import type {
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityProbeResult,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
} from './runtimeAccountIdentityTypes';

const indexedCandidate: RuntimeAccountIdentityEntry = {
  sessionId: 'sess_same',
  serviceId: 'openai-codex',
  groupId: 'team',
  profileId: 'stale-profile',
  providerAccountId: 'acct-a',
  accountLabel: 'same@example.test',
  observedAtMs: 900,
  source: 'spawn_selection',
  proofStrength: 'exact',
  groupGeneration: 4,
};

function runReconcileWithProbe(probeResult: RuntimeAccountIdentityProbeResult | Error) {
  const diagnostics: unknown[] = [];
  const invalidateRuntimeAccountIdentity = vi.fn();
  const recordRuntimeAccountIdentity = vi.fn((
    _entry: RuntimeAccountIdentityRecordInput,
  ): RuntimeAccountIdentityRecordResult => ({ status: 'recorded' }));
  const readRuntimeAccountIdentity = vi.fn(async () => {
    if (probeResult instanceof Error) throw probeResult;
    return probeResult;
  });

  return {
    diagnostics,
    invalidateRuntimeAccountIdentity,
    recordRuntimeAccountIdentity,
    readRuntimeAccountIdentity,
    result: reconcileIndexedSameAccountFanoutCandidates({
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      indexedCandidates: [indexedCandidate],
      readRuntimeAccountIdentity,
      now: () => 1_000,
      recordRuntimeAccountIdentity,
      invalidateRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    }),
  };
}

describe('reconcileIndexedSameAccountFanoutCandidates', () => {
  it('records a stable stale expected-state diagnostic when exact runtime identity repairs an indexed candidate', async () => {
    const reconciliation = runReconcileWithProbe({
      status: 'verified',
      strategy: 'provider_account_id',
      providerAccountId: 'acct-a',
      accountLabel: 'runtime@example.test',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
      profileId: 'runtime-profile',
      groupId: 'team',
      groupGeneration: 5,
    });

    await expect(reconciliation.result).resolves.toEqual([
      expect.objectContaining({
        profileId: 'runtime-profile',
        groupGeneration: 5,
        providerAccountId: 'acct-a',
      }),
    ]);
    expect(reconciliation.diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'runtime_identity_probe_stale_expected_state_reconciled',
    }));
    expect(reconciliation.recordRuntimeAccountIdentity).toHaveBeenCalledOnce();
  });

  it('records a stable missing-exact-identity diagnostic when the runtime probe is not exact', async () => {
    const reconciliation = runReconcileWithProbe({
      status: 'inexact',
      reason: 'exact_provider_account_proof_required',
    });

    await expect(reconciliation.result).resolves.toEqual([]);
    expect(reconciliation.diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'runtime_identity_probe_missing_exact_identity',
    }));
    expect(reconciliation.invalidateRuntimeAccountIdentity).toHaveBeenCalledWith('sess_same');
  });

  it('records a stable account-mismatch diagnostic when exact runtime identity points at another account', async () => {
    const reconciliation = runReconcileWithProbe({
      status: 'verified',
      strategy: 'provider_account_id',
      providerAccountId: 'acct-b',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
      profileId: 'stale-profile',
      groupId: 'team',
      groupGeneration: 4,
    });

    await expect(reconciliation.result).resolves.toEqual([]);
    expect(reconciliation.diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'runtime_identity_probe_account_mismatch',
      sessionId: 'sess_same',
      expectedProviderAccountId: 'acct-a',
      actualProviderAccountId: 'acct-b',
      expectedProfileId: 'stale-profile',
      actualProfileId: 'stale-profile',
      expectedGroupId: 'team',
      actualGroupId: 'team',
      expectedGroupGeneration: 4,
      actualGroupGeneration: 4,
    }));
    expect(reconciliation.invalidateRuntimeAccountIdentity).toHaveBeenCalledWith('sess_same');
  });
});

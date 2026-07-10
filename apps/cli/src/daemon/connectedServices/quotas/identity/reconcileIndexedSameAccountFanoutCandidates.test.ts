import { describe, expect, it, vi } from 'vitest';

import { reconcileIndexedSameAccountFanoutCandidates } from './reconcileIndexedSameAccountFanoutCandidates';
import { resolveRuntimeAccountIdentityFanoutMatch } from './resolveRuntimeAccountIdentityFanoutMatch';
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

  it('preserves unsupported runtime method as its own probe diagnostic', async () => {
    const reconciliation = runReconcileWithProbe({
      status: 'unavailable',
      reason: 'unsupported_session_runtime_method',
    });

    await expect(reconciliation.result).resolves.toEqual([]);
    expect(reconciliation.diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'unsupported_session_runtime_method',
      probeStatus: 'unavailable',
      probeReason: 'unsupported_session_runtime_method',
    }));
    expect(reconciliation.invalidateRuntimeAccountIdentity).toHaveBeenCalledWith('sess_same');
  });

  it('retains a daemon-authoritative candidate via its indexed identity WITHOUT a live probe', async () => {
    const readRuntimeAccountIdentity = vi.fn(async (): Promise<RuntimeAccountIdentityProbeResult> => ({
      status: 'verified',
      strategy: 'provider_account_id',
      providerAccountId: 'acct-a',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
    }));
    const invalidateRuntimeAccountIdentity = vi.fn();
    const recordRuntimeAccountIdentity = vi.fn((): RuntimeAccountIdentityRecordResult => ({ status: 'recorded' }));
    const diagnostics: unknown[] = [];

    const result = await reconcileIndexedSameAccountFanoutCandidates({
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      indexedCandidates: [indexedCandidate],
      readRuntimeAccountIdentity,
      resolveCandidateRequiresLiveIdentityProbe: () => false,
      now: () => 1_000,
      recordRuntimeAccountIdentity,
      invalidateRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    expect(result).toEqual([
      expect.objectContaining({ sessionId: 'sess_same', providerAccountId: 'acct-a' }),
    ]);
    expect(readRuntimeAccountIdentity).not.toHaveBeenCalled();
    expect(invalidateRuntimeAccountIdentity).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it('backs off re-probing a live-probe-required candidate whose method is unsupported (one record, no storm)', async () => {
    const unsupportedSessions = new Set<string>();
    const readRuntimeAccountIdentity = vi.fn(async (): Promise<RuntimeAccountIdentityProbeResult> => ({
      status: 'unavailable',
      reason: 'unsupported_session_runtime_method',
    }));
    const diagnostics: unknown[] = [];
    const shared = {
      serviceId: 'openai-codex' as const,
      groupId: 'team',
      providerAccountId: 'acct-a',
      indexedCandidates: [indexedCandidate],
      readRuntimeAccountIdentity,
      resolveCandidateRequiresLiveIdentityProbe: () => true,
      isLiveIdentityProbeUnsupported: (sessionId: string) => unsupportedSessions.has(sessionId),
      markLiveIdentityProbeUnsupported: (sessionId: string) => { unsupportedSessions.add(sessionId); },
      now: () => 1_000,
      recordRuntimeAccountIdentity: vi.fn((): RuntimeAccountIdentityRecordResult => ({ status: 'recorded' })),
      invalidateRuntimeAccountIdentity: vi.fn(),
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    };

    await reconcileIndexedSameAccountFanoutCandidates(shared);
    await reconcileIndexedSameAccountFanoutCandidates(shared);

    expect(readRuntimeAccountIdentity).toHaveBeenCalledTimes(1);
    expect(
      diagnostics.filter((event) => (event as { reason?: string }).reason === 'unsupported_session_runtime_method'),
    ).toHaveLength(1);
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

describe('resolveRuntimeAccountIdentityFanoutMatch', () => {
  it('returns shared auth-surface proof without a provider account sentinel', () => {
    const result = resolveRuntimeAccountIdentityFanoutMatch({
      strategy: 'shared_group_auth_surface',
      serviceId: 'claude-subscription',
      groupId: 'team',
      candidate: {
        sessionId: 'sess_shared',
        serviceId: 'claude-subscription',
        groupId: 'team',
        profileId: 'active-profile',
        accountLabel: null,
        groupGeneration: 4,
      },
      result: {
        status: 'verified',
        strategy: 'shared_group_auth_surface',
        sharedAuthSurfaceId: 'team',
        proofStrength: 'exact',
        source: 'runtime_identity_probe',
        profileId: 'active-profile',
        groupId: 'team',
        groupGeneration: 4,
      },
      observedAtMs: 1_000,
    });

    expect(result.status).toBe('matched');
    if (result.status !== 'matched') return;
    expect('providerAccountId' in result.entry).toBe(false);
    expect(result.entry).toMatchObject({
      proofStrategy: 'shared_group_auth_surface',
      sessionId: 'sess_shared',
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'active-profile',
      groupGeneration: 4,
    });
  });
});

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
  probeStatus?: RuntimeAccountIdentityProbeResult['status'];
  probeReason?: string | null;
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
    probeStatus?: RuntimeAccountIdentityProbeResult['status'];
    probeReason?: string | null;
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

const STABLE_UNSUPPORTED_PROBE_REASON = 'unsupported_session_runtime_method';

export async function reconcileIndexedSameAccountFanoutCandidates(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  providerAccountId: string;
  indexedCandidates: ReadonlyArray<RuntimeAccountIdentityEntry>;
  readRuntimeAccountIdentity?: RuntimeAccountIdentityReader | null;
  /**
   * Does this candidate's provider require a LIVE session-runtime identity probe (codex) or is its
   * account binding DAEMON-authoritative via broker/shared-group indirection (opencode/pi/claude)?
   * Broker-indirection candidates are retained via their daemon-owned indexed identity WITHOUT a live
   * probe: the runtime cannot answer the probe (returns `unsupported_session_runtime_method`), and the
   * daemon already owns the effective selection. Absent ⇒ live-probe (backward-compatible default).
   */
  resolveCandidateRequiresLiveIdentityProbe?: (
    candidate: RuntimeAccountIdentityEntry,
  ) => boolean | Promise<boolean>;
  /** Capability-aware backoff: an unsupported probe method is a STABLE per-session fact. */
  isLiveIdentityProbeUnsupported?: (sessionId: string) => boolean;
  markLiveIdentityProbeUnsupported?: (sessionId: string) => void;
  now: () => number;
  recordRuntimeAccountIdentity: (entry: RuntimeAccountIdentityRecordInput) => RuntimeAccountIdentityRecordResult;
  invalidateRuntimeAccountIdentity: (sessionId: string) => void;
  recordDiagnostic?: (event: SameAccountFanoutDiagnostic) => void;
}>): Promise<Array<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry>> {
  if (input.indexedCandidates.length === 0) {
    return [];
  }

  const reconciled: Array<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry> = [];
  for (const candidate of input.indexedCandidates) {
    const requiresLiveProbe = input.resolveCandidateRequiresLiveIdentityProbe
      ? await input.resolveCandidateRequiresLiveIdentityProbe(candidate)
      : true;

    // Daemon-authoritative (broker/shared-group indirection): the daemon owns the effective selection,
    // so the indexed identity that put this candidate in the same-account set IS authoritative. Retain
    // it and route it to the switch — a live probe here is unanswerable and only strands the candidate.
    if (!requiresLiveProbe) {
      const retained: RuntimeAccountIdentityEntry = { ...candidate, observedAtMs: input.now() };
      input.recordRuntimeAccountIdentity(retained);
      reconciled.push(retained);
      continue;
    }

    if (!input.readRuntimeAccountIdentity) {
      reconciled.push(candidate);
      continue;
    }

    // Capability-aware suppression backoff: an unsupported method never recovers for this session, so
    // skip the re-probe and the re-emit (one INFO-level record was written on the first encounter).
    if (input.isLiveIdentityProbeUnsupported?.(candidate.sessionId)) {
      input.invalidateRuntimeAccountIdentity(candidate.sessionId);
      continue;
    }

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

    // A live probe that reports the method is unsupported is a STABLE capability fact for this session
    // — remember it so the next tick backs off instead of re-probing + re-emitting the same diagnostic.
    if (result.status === 'unavailable' && result.reason === STABLE_UNSUPPORTED_PROBE_REASON) {
      input.markLiveIdentityProbeUnsupported?.(candidate.sessionId);
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
    if ('providerAccountId' in match.entry) {
      input.recordRuntimeAccountIdentity(match.entry);
    }
    reconciled.push(match.entry);
  }
  return reconciled;
}

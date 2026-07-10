import type { ConnectedServiceId } from '@happier-dev/protocol';

import { persistedSessionAccountIdentityMatchesFailingAccount } from './resolvePersistedMaterializationIdentityFanoutMatch';
import { resolveRuntimeAccountIdentityFanoutMatch } from './resolveRuntimeAccountIdentityFanoutMatch';
import type {
  PersistedSessionAccountIdentityReader,
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
  // Carries the proof source(s) tried (e.g. `runtime_identity_probe`, `persisted_materialization_identity`).
  // Typed `unknown` so it stays assignable to the coordinator's richer diagnostic type.
  decisionTrace?: unknown;
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
    decisionTrace?: unknown;
  }>,
): void {
  recordDiagnostic?.({
    event: 'quota_work_suppressed',
    phase: 'same_account_fanout',
    ...input,
  });
}

const STABLE_UNSUPPORTED_PROBE_REASON = 'unsupported_session_runtime_method';

/**
 * Build the durable retained entry when the persisted materialization identity supplies the fanout
 * proof. Recorded into the runtime identity index so the (cold) index re-warms and subsequent ticks
 * hit the fast indexed path.
 */
function buildPersistedFallbackEntry(input: Readonly<{
  candidate: RuntimeAccountIdentityEntry;
  serviceId: ConnectedServiceId;
  groupId: string;
  providerAccountId: string;
  observedAtMs: number;
}>): RuntimeAccountIdentityEntry {
  return {
    sessionId: input.candidate.sessionId,
    serviceId: input.serviceId,
    groupId: input.candidate.groupId ?? input.groupId,
    profileId: input.candidate.profileId,
    providerAccountId: input.providerAccountId,
    accountLabel: input.candidate.accountLabel,
    observedAtMs: input.observedAtMs,
    source: 'persisted_materialization_identity',
    proofStrength: 'exact',
    groupGeneration: input.candidate.groupGeneration,
  };
}

export async function reconcileIndexedSameAccountFanoutCandidates(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  providerAccountId: string;
  indexedCandidates: ReadonlyArray<RuntimeAccountIdentityEntry>;
  readRuntimeAccountIdentity?: RuntimeAccountIdentityReader | null;
  /**
   * Durable fallback proof source. When the live probe is UNAVAILABLE or INEXACT (never on a VERIFIED
   * mismatch), the candidate's persisted materialization identity can supply the fanout proof.
   */
  readPersistedSessionAccountIdentity?: PersistedSessionAccountIdentityReader | null;
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

  // Durable fallback: attempt the persisted materialization identity proof for a candidate whose live
  // probe could not verify identity (unavailable/inexact — NOT a verified mismatch). Returns the
  // retained entry (also recorded to re-warm the index) or null when no durable proof is available.
  const attemptPersistedFallback = async (
    candidate: RuntimeAccountIdentityEntry,
  ): Promise<RuntimeAccountIdentityEntry | null> => {
    if (!input.readPersistedSessionAccountIdentity) return null;
    let identity: Awaited<ReturnType<PersistedSessionAccountIdentityReader>>;
    try {
      identity = await input.readPersistedSessionAccountIdentity({
        sessionId: candidate.sessionId,
        serviceId: input.serviceId,
        groupId: candidate.groupId ?? input.groupId,
        profileId: candidate.profileId,
        expectedGroupGeneration: candidate.groupGeneration,
      });
    } catch {
      return null;
    }
    if (!identity) return null;
    const matched = persistedSessionAccountIdentityMatchesFailingAccount({
      identity,
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId: input.providerAccountId,
      candidate,
    });
    if (!matched) return null;
    const retained = buildPersistedFallbackEntry({
      candidate,
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId: input.providerAccountId,
      observedAtMs: input.now(),
    });
    input.recordRuntimeAccountIdentity(retained);
    input.recordDiagnostic?.({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_retained_via_persisted_materialization_identity',
      sessionId: candidate.sessionId,
      expectedProviderAccountId: input.providerAccountId,
      decisionTrace: { proofSource: 'persisted_materialization_identity' },
    });
    return retained;
  };

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
      const fallback = await attemptPersistedFallback(candidate);
      if (fallback) {
        reconciled.push(fallback);
        continue;
      }
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
        ...(input.readPersistedSessionAccountIdentity
          ? { decisionTrace: { proofSource: 'runtime_identity_probe', proofSourcesTried: ['runtime_identity_probe', 'persisted_materialization_identity'] } }
          : {}),
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
      // A VERIFIED live probe pointing at a genuinely different account is an authoritative veto —
      // never fall back. Only an unverifiable probe (unavailable/inexact) is eligible for the durable
      // persisted-identity fallback.
      if (result.status !== 'verified') {
        const fallback = await attemptPersistedFallback(candidate);
        if (fallback) {
          reconciled.push(fallback);
          continue;
        }
      }
      recordSuppression(input.recordDiagnostic, {
        reason: match.reason,
        ...match.diagnostic,
        ...(input.readPersistedSessionAccountIdentity && result.status !== 'verified'
          ? { decisionTrace: { proofSource: 'runtime_identity_probe', proofSourcesTried: ['runtime_identity_probe', 'persisted_materialization_identity'] } }
          : {}),
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

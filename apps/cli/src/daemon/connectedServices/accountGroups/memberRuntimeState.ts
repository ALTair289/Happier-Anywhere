import type {
  ConnectedServiceAuthGroupMemberStateV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import { clearConnectedServiceAuthGroupMemberRuntimeBlockers } from '@happier-dev/protocol';

import { logger as defaultLogger } from '@/ui/logger';

import type {
  ConnectedServiceAuthGroupMemberRuntimeState,
  ConnectedServiceAuthGroupPolicyV1,
  ConnectedServiceAuthGroupQuotaMeterSnapshot,
  ConnectedServiceAuthGroupQuotaSnapshot,
} from './selection/selectConnectedServiceAuthGroupCandidate';

export type ConnectedServiceMemberRuntimeStateApi = Readonly<{
  getConnectedServiceAuthGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupRuntimeState(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration: number;
    memberStates: ReadonlyArray<Readonly<{
      profileId: string;
      state: ConnectedServiceAuthGroupMemberStateV1;
    }>>;
  }>): Promise<ConnectedServiceAuthGroupV1>;
}>;

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function meterHasRemainingQuota(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  const remaining = numberOrNull(meter.remainingPct);
  return remaining !== null && remaining > 0;
}

function isQuotaMeter(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  return meter.limitCategory === 'usage_limit';
}

function isRateLimitMeter(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  return meter.limitCategory === 'rate_limit';
}

function snapshotProvesQuotaUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  if (snapshot.exhausted) return false;
  const quotaMeters = (snapshot.meters ?? []).filter(isQuotaMeter);
  if (quotaMeters.length > 0) return quotaMeters.every(meterHasRemainingQuota);
  const remaining = numberOrNull(snapshot.effectiveRemainingPercent);
  return remaining !== null && remaining > 0;
}

function snapshotProvesRateLimitUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  const rateLimitMeters = (snapshot.meters ?? []).filter(isRateLimitMeter);
  return rateLimitMeters.length > 0 && rateLimitMeters.every(meterHasRemainingQuota);
}

function resolveSnapshotEligibilityBlocker(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  nowMs: number,
): boolean {
  const meters = snapshot?.meters ?? [];
  if (meters.length === 0) return false;
  if (meters.some((meter) => meter.limitCategory === 'usage_limit' || meter.limitCategory === 'rate_limit' || meter.limitCategory === 'unknown')) {
    return false;
  }
  if (meters.some((meter) => numberOrNull(meter.resetAtMs) !== null && numberOrNull(meter.resetAtMs)! <= nowMs)) {
    return false;
  }
  const categories = new Set(meters.map((meter) => meter.limitCategory));
  return categories.has('auth_invalid')
    || categories.has('disabled')
    || categories.has('plan_invalid')
    || categories.has('validation_failed')
    || categories.has('capacity');
}

export type ConnectedServiceAuthGroupPositiveEvidence = Readonly<
  | {
      kind:
        | 'successful_spawn'
        | 'successful_turn'
        | 'credential_refresh'
        | 'oauth_token_callback'
        | 'account_adoption';
      observedAtMs: number;
    }
  | {
      kind: 'quota_headroom';
      observedAtMs: number;
      quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot;
    }
>;

function evidenceIsNewerThanFailure(
  evidence: ConnectedServiceAuthGroupPositiveEvidence,
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
): boolean {
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  return lastObservedAtMs === null || evidence.observedAtMs > lastObservedAtMs;
}

function positiveEvidenceProvesRuntimeUsable(
  evidence: ConnectedServiceAuthGroupPositiveEvidence,
  nowMs: number,
): boolean {
  if (evidence.kind !== 'quota_headroom') return true;
  if (evidence.quotaSnapshot.planUnavailable) return false;
  if (resolveSnapshotEligibilityBlocker(evidence.quotaSnapshot, nowMs)) return false;
  return snapshotProvesQuotaUsable(evidence.quotaSnapshot);
}

export function reconcileMemberRuntimeStateWithPositiveEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  evidence: ConnectedServiceAuthGroupPositiveEvidence;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  void params.policy;
  const state = params.state;
  if (!state || !evidenceIsNewerThanFailure(params.evidence, state)) return state;
  if (!positiveEvidenceProvesRuntimeUsable(params.evidence, params.nowMs)) return state;

  const cleared = clearConnectedServiceAuthGroupMemberRuntimeBlockers(state);
  return cleared === state ? state : cleared;
}

/**
 * The blocker-field names cleared between the pre- and post-reconcile member states. Field NAMES
 * are safe to log (no credentials); we never log the field values.
 */
function resolveClearedBlockerKinds(
  before: ConnectedServiceAuthGroupMemberRuntimeState,
  after: ConnectedServiceAuthGroupMemberRuntimeState,
): readonly string[] {
  const afterRecord = after as Record<string, unknown>;
  return Object.keys(before).filter(
    (key) => (before as Record<string, unknown>)[key] !== undefined && afterRecord[key] === undefined,
  );
}

export async function persistMemberRuntimeStateWithPositiveEvidence(params: Readonly<{
  api: ConnectedServiceMemberRuntimeStateApi;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  evidence: ConnectedServiceAuthGroupPositiveEvidence;
  normalizePolicy: (policy: ConnectedServiceAuthGroupV1['policy']) => ConnectedServiceAuthGroupPolicyV1;
  /**
   * Diagnosability sink (QA2-F01 / RR-8): the positive-evidence success chain was log-silent, so a
   * live clear of member blockers was invisible. NAMES only — never credential/token values.
   */
  logger?: Pick<typeof defaultLogger, 'info'>;
}>): Promise<boolean> {
  const group = await params.api.getConnectedServiceAuthGroup({
    serviceId: params.serviceId,
    groupId: params.groupId,
  });
  if (!group || group.generation !== params.generation) return false;
  const member = group.members.find((item) => item.profileId === params.profileId) ?? null;
  if (!member) return false;
  const reconciled = reconcileMemberRuntimeStateWithPositiveEvidence({
    state: member.state,
    evidence: params.evidence,
    policy: params.normalizePolicy(group.policy),
    nowMs: params.evidence.observedAtMs,
  });
  if (!reconciled || reconciled === member.state) return false;
  await params.api.updateConnectedServiceAuthGroupRuntimeState({
    serviceId: params.serviceId,
    groupId: params.groupId,
    expectedGeneration: group.generation,
    memberStates: [{ profileId: params.profileId, state: reconciled }],
  });
  (params.logger ?? defaultLogger).info('[DAEMON RUN] Connected-service member blockers cleared by positive evidence', {
    serviceId: params.serviceId,
    groupId: params.groupId,
    profileId: params.profileId,
    evidenceKind: params.evidence.kind,
    clearedBlockerKinds: resolveClearedBlockerKinds(member.state, reconciled),
  });
  return true;
}

export function reconcileMemberRuntimeStateWithFreshQuotaEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  const state = params.state;
  const quotaSnapshot = params.quotaSnapshot;
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  if (!state || !quotaSnapshot || (lastObservedAtMs !== null && quotaSnapshot.capturedAtMs <= lastObservedAtMs)) return state;

  const positiveReconciled = reconcileMemberRuntimeStateWithPositiveEvidence({
    state,
    evidence: {
      kind: 'quota_headroom',
      observedAtMs: quotaSnapshot.capturedAtMs,
      quotaSnapshot,
    },
    policy: params.policy,
    nowMs: params.nowMs,
  });
  if (positiveReconciled !== state) return positiveReconciled;

  let changed = false;
  const next: {
    -readonly [Key in keyof ConnectedServiceAuthGroupMemberRuntimeState]: ConnectedServiceAuthGroupMemberRuntimeState[Key];
  } = { ...state };

  const quotaUsable = snapshotProvesQuotaUsable(quotaSnapshot);
  if (
    quotaUsable
    && (
      numberOrNull(state.cooldownStartedAtMs) !== null
      || numberOrNull(state.cooldownUntilMs) !== null
      || numberOrNull(state.exhaustedUntilMs) !== null
    )
  ) {
    delete next.cooldownStartedAtMs;
    delete next.cooldownUntilMs;
    delete next.exhaustedUntilMs;
    changed = true;
  }

  if (quotaUsable && (numberOrNull(state.quotaExhaustedUntilMs) !== null || state.lastFailureKind === 'usage_limit')) {
    delete next.quotaExhaustedUntilMs;
    delete next.providerResetsAtMs;
    if (state.lastFailureKind === 'usage_limit') {
      delete next.lastFailureKind;
    }
    changed = true;
  }

  const rateUsable = snapshotProvesRateLimitUsable(quotaSnapshot);
  if (rateUsable && (numberOrNull(state.rateLimitedUntilMs) !== null || state.lastFailureKind === 'rate_limit')) {
    delete next.rateLimitedUntilMs;
    delete next.providerResetsAtMs;
    if (state.lastFailureKind === 'rate_limit') {
      delete next.lastFailureKind;
    }
    changed = true;
  }

  return changed ? next : state;
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function resolveLimiterRetryAtMs(retryAtMs: number | null): number | null {
  return retryAtMs;
}

function resolveAuthFailureRetryAtMs(input: Readonly<{
  policy: ConnectedServiceAuthGroupPolicyV1;
  retryAtMs: number | null;
  observedAtMs: number;
}>): number | null {
  if (input.retryAtMs !== null) return input.retryAtMs;
  const cooldownMs = readNonNegativeNumber(input.policy.cooldownMs);
  return cooldownMs === null ? null : input.observedAtMs + cooldownMs;
}

export function buildObservedFailureMemberRuntimeState(input: Readonly<{
  existing: ConnectedServiceAuthGroupMemberRuntimeState | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  reason: string;
  retryAtMs: number | null;
  planType: string | null | undefined;
  observedAtMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState {
  const existing = input.existing ?? {};
  const state: ConnectedServiceAuthGroupMemberRuntimeState = {
    ...(existing.cooldownUntilMs === undefined ? {} : { cooldownUntilMs: existing.cooldownUntilMs }),
    ...(existing.exhaustedUntilMs === undefined ? {} : { exhaustedUntilMs: existing.exhaustedUntilMs }),
    ...(existing.quotaExhaustedUntilMs === undefined ? {} : { quotaExhaustedUntilMs: existing.quotaExhaustedUntilMs }),
    ...(existing.rateLimitedUntilMs === undefined ? {} : { rateLimitedUntilMs: existing.rateLimitedUntilMs }),
    ...(existing.capacityLimitedUntilMs === undefined ? {} : { capacityLimitedUntilMs: existing.capacityLimitedUntilMs }),
    ...(existing.authInvalidUntilMs === undefined ? {} : { authInvalidUntilMs: existing.authInvalidUntilMs }),
    ...(existing.planUnavailableUntilMs === undefined ? {} : { planUnavailableUntilMs: existing.planUnavailableUntilMs }),
    ...(existing.validationBlockedUntilMs === undefined ? {} : { validationBlockedUntilMs: existing.validationBlockedUntilMs }),
    lastFailureKind: input.reason,
    lastObservedAtMs: input.observedAtMs,
    ...(input.planType ? { lastObservedPlanType: input.planType } : {}),
  };
  switch (input.reason) {
    case 'usage_limit':
      return { ...state, quotaExhaustedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs) };
    case 'rate_limit':
      return { ...state, rateLimitedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs) };
    case 'capacity':
      return { ...state, capacityLimitedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs) };
    case 'auth_expired':
    case 'auth_failed':
    case 'refresh_failed':
    case 'account_disabled':
      return {
        ...state,
        credentialHealthStatus: 'needs_reauth',
        authInvalidUntilMs: resolveAuthFailureRetryAtMs({
          policy: input.policy,
          retryAtMs: input.retryAtMs,
          observedAtMs: input.observedAtMs,
        }),
      };
    case 'plan':
      return { ...state, planUnavailableUntilMs: input.retryAtMs };
    case 'validation':
      return { ...state, validationBlockedUntilMs: input.retryAtMs };
    default:
      return state;
  }
}

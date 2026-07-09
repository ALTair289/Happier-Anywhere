import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceSameAccountFanoutStrategy } from './providerFanoutStrategy';
import type {
  ReconciledRuntimeAccountIdentityEntry,
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityProbeResult,
  RuntimeAccountIdentitySource,
} from './runtimeAccountIdentityTypes';

export type RuntimeIdentityFanoutSuppressionReason =
  | 'runtime_identity_probe_missing_exact_identity'
  | 'runtime_identity_probe_account_mismatch'
  | (string & {});

export type RuntimeIdentityFanoutSuppressionDiagnostic = Readonly<{
  sessionId: string;
  probeStatus?: RuntimeAccountIdentityProbeResult['status'];
  probeReason?: string | null;
  expectedProviderAccountId?: string | null;
  actualProviderAccountId?: string | null;
  expectedProfileId: string;
  actualProfileId?: string | null;
  expectedGroupId: string;
  actualGroupId?: string | null;
  expectedGroupGeneration: number | null;
  actualGroupGeneration?: number | null;
}>;

function readNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function readGeneration(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function buildSuppressionDiagnostic(input: Readonly<{
  candidate: Readonly<{
    sessionId: string;
    profileId: string;
    groupId: string | null;
    groupGeneration: number | null;
  }>;
  groupId: string;
  providerAccountId?: string | null;
  result: RuntimeAccountIdentityProbeResult;
}>): RuntimeIdentityFanoutSuppressionDiagnostic {
  return {
    sessionId: input.candidate.sessionId,
    probeStatus: input.result.status,
    probeReason: input.result.status === 'verified' ? null : input.result.reason ?? null,
    expectedProviderAccountId: readNonEmptyString(input.providerAccountId),
    actualProviderAccountId: readNonEmptyString(
      input.result.status === 'verified' ? input.result.providerAccountId : null,
    ),
    expectedProfileId: input.candidate.profileId,
    actualProfileId: readNonEmptyString(
      input.result.status === 'verified' ? input.result.profileId : null,
    ) ?? input.candidate.profileId,
    expectedGroupId: input.candidate.groupId ?? input.groupId,
    actualGroupId: readNonEmptyString(
      input.result.status === 'verified' ? input.result.groupId : null,
    ) ?? input.candidate.groupId ?? input.groupId,
    expectedGroupGeneration: readGeneration(input.candidate.groupGeneration),
    actualGroupGeneration: readGeneration(
      input.result.status === 'verified' ? input.result.groupGeneration : null,
    ) ?? readGeneration(input.candidate.groupGeneration),
  };
}

function resolveUnavailableSuppressionReason(
  result: RuntimeAccountIdentityProbeResult,
): RuntimeIdentityFanoutSuppressionReason {
  if (result.status === 'unavailable' && readNonEmptyString(result.reason)) {
    return readNonEmptyString(result.reason) ?? 'runtime_identity_probe_missing_exact_identity';
  }
  return 'runtime_identity_probe_missing_exact_identity';
}

export function resolveRuntimeAccountIdentityFanoutMatch(input: Readonly<{
  strategy: ConnectedServiceSameAccountFanoutStrategy;
  serviceId: ConnectedServiceId;
  groupId: string;
  providerAccountId?: string | null;
  candidate: Pick<
    RuntimeAccountIdentityEntry,
    'sessionId' | 'serviceId' | 'groupId' | 'profileId' | 'accountLabel' | 'groupGeneration'
  >;
  result: RuntimeAccountIdentityProbeResult;
  observedAtMs: number;
}>):
  | Readonly<{
      status: 'matched';
      entry: ReconciledRuntimeAccountIdentityEntry;
      staleExpectedStateReconciled: boolean;
    }>
  | Readonly<{
      status: 'suppressed';
      reason: RuntimeIdentityFanoutSuppressionReason;
      diagnostic: RuntimeIdentityFanoutSuppressionDiagnostic;
    }> {
  if (input.result.status !== 'verified' || input.result.proofStrength !== 'exact') {
    return {
      status: 'suppressed',
      reason: resolveUnavailableSuppressionReason(input.result),
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  const strategy = input.result.strategy ?? 'provider_account_id';
  const expectedProviderAccountId = readNonEmptyString(input.providerAccountId);
  const providerAccountId = readNonEmptyString(input.result.providerAccountId);
  const sharedAuthSurfaceId = readNonEmptyString(input.result.sharedAuthSurfaceId) ?? readNonEmptyString(input.result.groupId);
  if (input.strategy === 'provider_account_id') {
    if (strategy !== 'provider_account_id' || !providerAccountId || !expectedProviderAccountId) {
      return {
        status: 'suppressed',
        reason: 'runtime_identity_probe_missing_exact_identity',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
    if (providerAccountId !== expectedProviderAccountId) {
      return {
        status: 'suppressed',
        reason: 'runtime_identity_probe_account_mismatch',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
  } else if (input.strategy === 'shared_group_auth_surface') {
    if (strategy !== 'shared_group_auth_surface' || sharedAuthSurfaceId !== input.groupId) {
      return {
        status: 'suppressed',
        reason: 'runtime_identity_probe_account_mismatch',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
  } else {
    return {
      status: 'suppressed',
      reason: 'runtime_identity_probe_missing_exact_identity',
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  const runtimeGroupId = readNonEmptyString(input.result.groupId);
  if (runtimeGroupId && runtimeGroupId !== input.groupId) {
    return {
      status: 'suppressed',
      reason: 'runtime_identity_probe_account_mismatch',
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  const runtimeProfileId = readNonEmptyString(input.result.profileId);
  const runtimeGroupGeneration = readGeneration(input.result.groupGeneration);
  const nextProfileId = runtimeProfileId ?? input.candidate.profileId;
  const nextGroupId = runtimeGroupId ?? input.candidate.groupId ?? input.groupId;
  const nextGroupGeneration = runtimeGroupGeneration ?? input.candidate.groupGeneration;
  const staleExpectedStateReconciled = (
    nextProfileId !== input.candidate.profileId
    || nextGroupId !== (input.candidate.groupId ?? input.groupId)
    || nextGroupGeneration !== input.candidate.groupGeneration
  );
  const accountLabel = readNonEmptyString(input.result.accountLabel) ?? input.candidate.accountLabel;
  const source = input.result.source ?? 'runtime_identity_probe';
  const runtime = input.result.runtime ? { runtime: input.result.runtime } : {};

  if (input.strategy === 'shared_group_auth_surface') {
    return {
      status: 'matched',
      staleExpectedStateReconciled,
      entry: {
        proofStrategy: 'shared_group_auth_surface',
        sessionId: input.candidate.sessionId,
        serviceId: input.serviceId,
        groupId: nextGroupId,
        profileId: nextProfileId,
        accountLabel,
        observedAtMs: input.observedAtMs,
        source: source === 'group_switch_selection' ? source : 'runtime_identity_probe',
        proofStrength: 'exact',
        groupGeneration: nextGroupGeneration,
        ...runtime,
      },
    };
  }

  if (!providerAccountId) {
    return {
      status: 'suppressed',
      reason: 'runtime_identity_probe_missing_exact_identity',
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  return {
    status: 'matched',
    staleExpectedStateReconciled,
    entry: {
      sessionId: input.candidate.sessionId,
      serviceId: input.serviceId,
      groupId: nextGroupId,
      profileId: nextProfileId,
      providerAccountId,
      accountLabel,
      observedAtMs: input.observedAtMs,
      source: source as RuntimeAccountIdentitySource,
      proofStrength: 'exact',
      groupGeneration: nextGroupGeneration,
      ...runtime,
    },
  };
}

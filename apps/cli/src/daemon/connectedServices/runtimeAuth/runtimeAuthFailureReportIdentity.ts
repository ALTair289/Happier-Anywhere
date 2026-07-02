import { type SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';

type StableRuntimeAuthFailureClassificationIdentity = Readonly<{
  kind: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration: number | null;
  activeProfileId: string | null;
  credentialHealthStatus: string | null;
  identityProofVersion: number | null;
  sourceKey: string | null;
  providerAccountUsageRecordId: string | null;
  limitCategory: string | null;
  providerLimitId: string | null;
  sourceProviderAccountId: string | null;
  recoveryActionKind: string | null;
  resetsAtMsBucket: number | null;
}>;

function readRecoveryActionKind(value: unknown): string | null {
  return value && typeof value === 'object' && !Array.isArray(value) && (
    (value as { kind?: unknown }).kind === 'provider_state_sharing_required'
      || (value as { kind?: unknown }).kind === 'quota_recovery_required'
  )
    ? String((value as { kind: string }).kind)
    : null;
}

export function readStableRuntimeAuthFailureClassificationIdentity(
  classification: unknown,
): StableRuntimeAuthFailureClassificationIdentity | null {
  const parsed = sanitizeConnectedServiceRuntimeFailureClassification(classification);
  if (!parsed) return null;
  const resetsAtMsBucket = typeof parsed.resetsAtMs === 'number' && Number.isFinite(parsed.resetsAtMs)
    ? Math.floor(parsed.resetsAtMs / 60_000)
    : null;
  return {
    kind: parsed.kind,
    serviceId: parsed.serviceId,
    profileId: parsed.profileId,
    groupId: parsed.groupId,
    groupGeneration: parsed.groupGeneration ?? null,
    activeProfileId: parsed.activeProfileId ?? null,
    credentialHealthStatus: parsed.credentialHealthStatus ?? null,
    identityProofVersion: parsed.identityProofVersion ?? null,
    sourceKey: parsed.sourceKey ?? null,
    providerAccountUsageRecordId: parsed.providerAccountUsageRecordId ?? null,
    limitCategory: parsed.limitCategory ?? null,
    providerLimitId: parsed.providerLimitId ?? null,
    sourceProviderAccountId: parsed.sourceProviderAccountId ?? null,
    recoveryActionKind: readRecoveryActionKind(parsed.recoveryAction),
    resetsAtMsBucket,
  };
}

export function buildStableRuntimeAuthFailureReportDedupeKey(input: Readonly<{
  sessionId: string;
  switchesThisTurn: number;
  resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1 | null;
  classification: unknown;
}>): string | null {
  const classificationIdentity = readStableRuntimeAuthFailureClassificationIdentity(input.classification);
  if (!classificationIdentity) return null;
  return JSON.stringify({
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn,
    resumePromptMode: input.resumePromptMode,
    ...classificationIdentity,
  });
}

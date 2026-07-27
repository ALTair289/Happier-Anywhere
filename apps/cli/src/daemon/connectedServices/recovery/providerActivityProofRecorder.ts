import { ConnectedServiceIdSchema, type SessionContinuationRecoveryIdentityV1 } from '@happier-dev/protocol';

import { listMatchingRuntimeAuthRecoveryIntents } from '../runtimeAuth/matchRuntimeAuthRecoveryIntent';
import { buildRuntimeAuthRecoveryKey } from '../runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import type { ProviderOutcomeProofKind } from './providerOutcomeProof';

type RuntimeAuthRecoveryForProviderActivityProof = Readonly<{
  readForSession: (sessionId: string) => ReadonlyArray<RuntimeAuthRecoveryIntent>;
  markProviderOutcomeProofByKey: (input: Readonly<{
    recoveryKey: string;
    proofKind: ProviderOutcomeProofKind;
    expectedAttemptId?: string;
    observedAtMs?: number;
  }>) => Promise<unknown>;
}>;

type UsageLimitRecoveryForProviderActivityProof = Readonly<{
  markProviderOutcomeProofForSession: (input: Readonly<{
    sessionId: string;
    proofKind: ProviderOutcomeProofKind;
    serviceId: string;
    profileId?: string | null;
    groupId?: string | null;
    expectedRuntimeAuthRecoveryAttemptId?: string;
  }>) => Promise<unknown>;
}>;

export type ConnectedServiceProviderActivityProofRecorder = (input: Readonly<{
  sessionId: string;
  recoveryIdentities?: readonly SessionContinuationRecoveryIdentityV1[];
}>) => Promise<void>;

/**
 * REV-1: gate for treating a turn-lifecycle event as `provider_activity` proof.
 * `assistant_message_end` is also emitted by failTurn / ACP turn_failed markers;
 * a FAILED turn (the usage-limit interruption itself) must not clear the very
 * recovery intents it just armed. A missing terminal status (legacy producers)
 * keeps the completed-turn behavior.
 */
export function isProviderActivityTurnLifecycleEvent(
  event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
  terminalStatus?: 'completed' | 'failed',
): boolean {
  return event === 'assistant_message_end' && terminalStatus !== 'failed';
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * The `provider_activity` proof PRODUCER (closed outcome-proof union,
 * providerOutcomeProof.ts). Provider-qualified completion activity
 * (`assistant_message_end`) that matches an exact recovery identity clears the
 * matching runtime-auth and usage-limit intents directly. `task_started` is
 * deliberately excluded because task dispatch is not provider acceptance.
 *
 * Provider activity itself is the proof; no continuation attempt or metadata
 * participates in this decision.
 */
export function createConnectedServiceProviderActivityProofRecorder(params: Readonly<{
  runtimeAuthRecovery?: RuntimeAuthRecoveryForProviderActivityProof | null;
  usageLimitRecovery?: UsageLimitRecoveryForProviderActivityProof | null;
  nowMs?: () => number;
  logDebug?: (message: string, error: unknown) => void;
}>): ConnectedServiceProviderActivityProofRecorder {
  const clearMatchingRuntimeAuthIntents = async (input: Readonly<{
    sessionId: string;
    recoveryIdentity: SessionContinuationRecoveryIdentityV1;
    serviceId: ReturnType<typeof ConnectedServiceIdSchema.parse>;
  }>): Promise<void> => {
    if (!params.runtimeAuthRecovery) return;
    const serviceId = input.serviceId;
    const intents = params.runtimeAuthRecovery.readForSession(input.sessionId);
    const failureFingerprint = normalizeOptionalString(input.recoveryIdentity.failureFingerprint);
    const matches = listMatchingRuntimeAuthRecoveryIntents(intents, {
      serviceId,
      groupId: input.recoveryIdentity.groupId ?? null,
      profileId: input.recoveryIdentity.profileId ?? null,
    }).filter((intent) => {
      if (!failureFingerprint || intent.attemptId !== failureFingerprint) return false;
      if (input.recoveryIdentity.selectionKind !== 'group') return true;
      const matchesPendingTarget = intent.pendingTargetProfileId === input.recoveryIdentity.profileId
        && intent.pendingTargetGeneration === input.recoveryIdentity.targetGeneration;
      if (matchesPendingTarget) return true;
      return intent.status === 'resumed_awaiting_proof'
        && intent.pendingTargetProfileId == null
        && intent.pendingTargetGeneration == null
        && intent.profileId === input.recoveryIdentity.profileId
        && typeof intent.classification.groupGeneration === 'number'
        && typeof input.recoveryIdentity.targetGeneration === 'number'
        && input.recoveryIdentity.targetGeneration >= intent.classification.groupGeneration;
    });
    await Promise.all(matches.map(async (intent) => {
      await params.runtimeAuthRecovery?.markProviderOutcomeProofByKey({
        recoveryKey: buildRuntimeAuthRecoveryKey({
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          profileId: intent.profileId,
          groupId: intent.groupId,
        }),
        proofKind: 'provider_activity',
        expectedAttemptId: failureFingerprint!,
        observedAtMs: params.nowMs?.() ?? Date.now(),
      });
    }));
  };

  const recordScopedProviderActivity = async (input: Readonly<{
    sessionId: string;
    recoveryIdentity: SessionContinuationRecoveryIdentityV1;
  }>): Promise<void> => {
    const recoveryIdentity = input.recoveryIdentity;
    const runtimeAuthRecoveryAttemptId = normalizeOptionalString(recoveryIdentity.failureFingerprint);
    // A service/group/profile tuple from launch bindings is not an exact post-boundary outcome.
    // Continuation-owned provider leaves must carry the frozen failure boundary and, for groups,
    // the adopted generation. Inferred durable-intent identities deliberately never qualify.
    if (
      !runtimeAuthRecoveryAttemptId
      || (recoveryIdentity.selectionKind === 'group'
        && (typeof recoveryIdentity.targetGeneration !== 'number'
          || !Number.isInteger(recoveryIdentity.targetGeneration)
          || recoveryIdentity.targetGeneration < 0))
    ) {
      return;
    }
    const serviceId = ConnectedServiceIdSchema.safeParse(recoveryIdentity.serviceId);
    if (!serviceId.success) {
      params.logDebug?.(
        '[DAEMON RUN] Skipping connected-service provider-activity proof for invalid service id (non-fatal)',
        serviceId.error,
      );
      return;
    }
    await clearMatchingRuntimeAuthIntents({
      sessionId: input.sessionId,
      recoveryIdentity,
      serviceId: serviceId.data,
    }).catch((error) => {
      params.logDebug?.('[DAEMON RUN] Failed to clear runtime-auth recovery after connected-service provider activity (non-fatal)', error);
    });
    await params.usageLimitRecovery?.markProviderOutcomeProofForSession({
      sessionId: input.sessionId,
      proofKind: 'provider_activity',
      serviceId: serviceId.data,
      profileId: recoveryIdentity.profileId ?? null,
      groupId: recoveryIdentity.groupId ?? null,
      expectedRuntimeAuthRecoveryAttemptId: runtimeAuthRecoveryAttemptId,
    }).catch((error) => {
      params.logDebug?.('[DAEMON RUN] Failed to clear usage-limit recovery after connected-service provider activity (non-fatal)', error);
    });
  };

  return async (input) => {
    const explicitIdentities = input.recoveryIdentities ?? [];
    if (explicitIdentities.length === 0) return;
    for (const recoveryIdentity of explicitIdentities) {
      await recordScopedProviderActivity({
        sessionId: input.sessionId,
        recoveryIdentity,
      });
    }
  };
}

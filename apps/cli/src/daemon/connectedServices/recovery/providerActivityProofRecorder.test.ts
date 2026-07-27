import { describe, expect, it, vi } from 'vitest';

import { RuntimeAuthRecoveryScheduler } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from '../runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import { listProviderActivityRecoveryIdentitiesFromRuntimeBindings } from '../continuation/continuationRecoveryIdentity';
import {
  createConnectedServiceProviderActivityProofRecorder,
  isProviderActivityTurnLifecycleEvent,
} from './providerActivityProofRecorder';

describe('createConnectedServiceProviderActivityProofRecorder', () => {
  it('does not upgrade a coarse binding identity into exact provider-outcome proof', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });
    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    });
    const markUsageProof = vi.fn(async () => undefined);
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      runtimeAuthRecovery: scheduler,
      usageLimitRecovery: { markProviderOutcomeProofForSession: markUsageProof },
    });

    await recorder({
      sessionId: 'session-1',
      recoveryIdentities: [{
        serviceId: 'openai-codex',
        selectionKind: 'group',
        groupId: 'main',
        profileId: 'primary',
      }],
    });

    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    }))).toMatchObject({ status: 'waiting' });
    expect(markUsageProof).not.toHaveBeenCalled();
  });

  it('accepts only completed provider output as lifecycle proof', () => {
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end', 'completed')).toBe(true);
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end', 'failed')).toBe(false);
    expect(isProviderActivityTurnLifecycleEvent('task_started')).toBe(false);
  });

  it('settles only the exact recovery attempt carried by qualified provider activity', async () => {
    const markProviderOutcomeProofByKey = vi.fn(async () => undefined);
    const markUsageLimitProviderOutcomeProof = vi.fn(async () => undefined);
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      runtimeAuthRecovery: {
        readForSession: () => [{
          sessionId: 'session-1',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          status: 'resumed_awaiting_proof',
          attemptId: 'runtime-auth-attempt:current',
          pendingTargetProfileId: 'backup',
          pendingTargetGeneration: 18,
        }] as never,
        markProviderOutcomeProofByKey,
      },
      nowMs: () => 2_000,
      usageLimitRecovery: {
        markProviderOutcomeProofForSession: markUsageLimitProviderOutcomeProof,
      },
    });

    await recorder({
      sessionId: 'session-1',
      recoveryIdentities: [{
        serviceId: 'openai-codex',
        selectionKind: 'group',
        groupId: 'main',
        profileId: 'backup',
        failureFingerprint: 'runtime-auth-attempt:current',
        targetGeneration: 18,
      }],
    });

    expect(markProviderOutcomeProofByKey).toHaveBeenCalledWith({
      recoveryKey: buildRuntimeAuthRecoveryKey({
        sessionId: 'session-1',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
      }),
      proofKind: 'provider_activity',
      expectedAttemptId: 'runtime-auth-attempt:current',
      observedAtMs: 2_000,
    });
    expect(markUsageLimitProviderOutcomeProof).toHaveBeenCalledWith({
      sessionId: 'session-1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'main',
      expectedRuntimeAuthRecoveryAttemptId: 'runtime-auth-attempt:current',
    });
  });

  it('settles refresh-without-switch only from exact post-boundary current-binding activity', async () => {
    let observedAtMs = 1_100;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-refresh',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-pool',
    });
    const attempt = await scheduler.beginClassifiedFailure({
      sessionId: 'session-refresh',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        profileId: 'claude-primary',
        groupId: 'claude-pool',
        groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    });
    await scheduler.markAwaitingProviderOutcomeProofForResultByKey({
      recoveryKey,
      expectedAttemptId: attempt.attemptId,
      result: { status: 'credential_refreshed' },
    });
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      runtimeAuthRecovery: scheduler,
      nowMs: () => observedAtMs,
    });
    const currentBinding = {
      serviceId: 'claude-subscription',
      groupId: 'claude-pool',
      profileId: 'claude-primary',
      generation: 8,
      credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
    } as const;

    observedAtMs = 999;
    await recorder({
      sessionId: 'session-refresh',
      recoveryIdentities: listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
        [currentBinding],
        scheduler.readForSession('session-refresh'),
      ),
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof' });

    observedAtMs = 1_100;
    await recorder({
      sessionId: 'session-refresh',
      recoveryIdentities: listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
        [currentBinding],
        scheduler.readForSession('session-refresh'),
      ),
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'recovered',
      attemptId: attempt.attemptId,
    });
  });
});

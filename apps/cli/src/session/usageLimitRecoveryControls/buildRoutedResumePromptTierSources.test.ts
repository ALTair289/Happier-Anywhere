import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildRoutedResumePromptTierSources } from './buildRoutedResumePromptTierSources';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: 'sess_1',
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  } as RawSessionRecord;
}

function createUsageLimitIssueWithGroup() {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    providerTurnId: 'turn-1',
    occurredAt: 1_700_000_000_000,
    usageLimit: {
      v: 1,
      resetAtMs: 1_700_000_060_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'switch_account',
      connectedService: {
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: null,
      },
    },
  } as const;
}

const groupIntentMetadata = {
  sessionUsageLimitRecoveryV1: {
    v: 1,
    status: 'waiting',
    issueFingerprint: 'usage-limit:sess_1:reset',
    armedAtMs: 1,
    resetAtMs: 2,
    nextCheckAtMs: 2,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'codex-intent-group', profileId: null },
  },
};

describe('buildRoutedResumePromptTierSources', () => {
  it('reads the account tier through the provided account settings reader', () => {
    const sources = buildRoutedResumePromptTierSources({
      credentials: createCredentials(),
      metadata: null,
      rawSession: createRawSession(),
      readAccountSettings: () => ({ usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } }),
    });

    expect(sources.accountSettings).toEqual({ usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } });
  });

  it('loads group policy for the stored intent group before the latest-issue group', async () => {
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      groupId: 'codex-intent-group',
      policy: { resumePromptMode: 'off' },
    } as never));

    const sources = buildRoutedResumePromptTierSources({
      credentials: createCredentials(),
      metadata: groupIntentMetadata,
      rawSession: createRawSession({ lastRuntimeIssue: createUsageLimitIssueWithGroup() }),
      createGroupPolicyApi: async () => ({ getConnectedServiceAuthGroup }),
      readAccountSettings: () => null,
    });

    await expect(sources.loadGroupPolicy?.()).resolves.toEqual({ resumePromptMode: 'off' });
    expect(getConnectedServiceAuthGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'codex-intent-group',
    });
  });

  it('falls back to the latest usage-limit issue group when no intent group exists', async () => {
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      groupId: 'codex-main',
      policy: { resumePromptMode: 'standard' },
    } as never));

    const sources = buildRoutedResumePromptTierSources({
      credentials: createCredentials(),
      metadata: { machineId: 'machine-local' },
      rawSession: createRawSession({ lastRuntimeIssue: createUsageLimitIssueWithGroup() }),
      createGroupPolicyApi: async () => ({ getConnectedServiceAuthGroup }),
      readAccountSettings: () => null,
    });

    await expect(sources.loadGroupPolicy?.()).resolves.toEqual({ resumePromptMode: 'standard' });
    expect(getConnectedServiceAuthGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'codex-main',
    });
  });

  it('resolves a null group tier without fetching when no group identity exists', async () => {
    const getConnectedServiceAuthGroup = vi.fn(async () => null);

    const sources = buildRoutedResumePromptTierSources({
      credentials: createCredentials(),
      metadata: { machineId: 'machine-local' },
      rawSession: createRawSession(),
      createGroupPolicyApi: async () => ({ getConnectedServiceAuthGroup }),
      readAccountSettings: () => null,
    });

    await expect(sources.loadGroupPolicy?.()).resolves.toBeNull();
    expect(getConnectedServiceAuthGroup).not.toHaveBeenCalled();
  });

});

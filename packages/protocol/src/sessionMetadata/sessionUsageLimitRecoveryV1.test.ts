import { describe, expect, it } from 'vitest';

import {
  SessionUsageLimitRecoveryV1Schema,
  resolveSessionUsageLimitRecoveryResumePromptModeV1,
} from './sessionUsageLimitRecoveryV1.js';

const baseIntent = {
  v: 1,
  status: 'waiting',
  issueFingerprint: 'usage-limit:sess_1:reset',
  armedAtMs: 1,
  resetAtMs: 2,
  nextCheckAtMs: 2,
  attemptCount: 0,
  maxAttempts: 3,
  lastProbeError: null,
  selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
} as const;

describe('SessionUsageLimitRecoveryV1', () => {
  it('defaults and persists resumePromptMode on stored recovery intents', () => {
    expect(SessionUsageLimitRecoveryV1Schema.parse(baseIntent)).toMatchObject({
      resumePromptMode: 'standard',
    });
    expect(SessionUsageLimitRecoveryV1Schema.parse({
      ...baseIntent,
      resumePromptMode: 'off',
    })).toMatchObject({
      resumePromptMode: 'off',
    });
    expect(SessionUsageLimitRecoveryV1Schema.safeParse({
      ...baseIntent,
      resumePromptMode: 'sometimes',
    }).success).toBe(false);
  });

  it('preserves the exact runtime-auth recovery attempt identity when projected', () => {
    expect(SessionUsageLimitRecoveryV1Schema.parse({
      ...baseIntent,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).toMatchObject({
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('accepts group recovery auth selections without a known profile id', () => {
    expect(SessionUsageLimitRecoveryV1Schema.safeParse({
      ...baseIntent,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: null,
      },
    }).success).toBe(true);
  });

  it('accepts generalized recovery-credit inventory on stored recovery intents', () => {
    expect(SessionUsageLimitRecoveryV1Schema.parse({
      ...baseIntent,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        totalCount: 1,
        nextExpiresAtMs: 1_701_000_000_000,
        source: 'provider_api',
        confidence: 'exact',
        credits: [{
          providerCreditId: 'reset-credit-1',
          kind: 'usage_limit_reset',
          status: 'available',
          grantedAtMs: 1_699_000_000_000,
          expiresAtMs: 1_701_000_000_000,
          redeemedAtMs: null,
          title: 'Codex reset',
          description: null,
        }],
      },
    })).toMatchObject({
      recoveryCredits: {
        availableCount: 1,
        totalCount: 1,
        credits: [{
          providerCreditId: 'reset-credit-1',
          kind: 'usage_limit_reset',
          status: 'available',
        }],
      },
    });
  });

  it('resolves resumePromptMode by explicit, existing intent, group, account, then default precedence', () => {
    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      explicit: 'standard',
      existingIntent: { resumePromptMode: 'off' },
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      groupPolicy: { resumePromptMode: 'off' },
    })).toBe('standard');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      explicit: null,
      existingIntent: { resumePromptMode: 'off' },
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
      groupPolicy: { resumePromptMode: 'standard' },
    })).toBe('off');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      existingIntent: {},
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      groupPolicy: { resumePromptMode: 'standard' },
    })).toBe('standard');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      accountSettings: {},
      groupPolicy: { resumePromptMode: 'off' },
    })).toBe('off');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      groupPolicy: {},
    })).toBe('standard');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({})).toBe('standard');
  });

  it('resolves custom resume prompt mode like any tier value', () => {
    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      explicit: 'custom',
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
    })).toBe('custom');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } },
      groupPolicy: { resumePromptMode: 'off' },
    })).toBe('off');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { resolveRoutedUsageLimitRecoveryResumePromptMode } from './resolveRoutedUsageLimitRecoveryResumePromptMode';

const offIntent = {
  v: 1,
  status: 'waiting',
  issueFingerprint: 'usage-limit:sess_1:reset',
  armedAtMs: 1,
  resetAtMs: 2,
  nextCheckAtMs: 2,
  attemptCount: 0,
  maxAttempts: 3,
  lastProbeError: null,
  resumePromptMode: 'off',
  selectedAuth: { kind: 'native' },
} as const;

describe('resolveRoutedUsageLimitRecoveryResumePromptMode', () => {
  it('resolves the full plan tier order: explicit > intent > group > account > default', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'standard',
      existingIntent: offIntent,
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      loadGroupPolicy: () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('standard');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      existingIntent: offIntent,
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      loadGroupPolicy: () => ({ resumePromptMode: 'standard' }),
    })).resolves.toBe('standard');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadGroupPolicy: () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({})).resolves.toBe('standard');
  });

  it('loads group policy before consulting the lower account tier', async () => {
    const loadGroupPolicy = vi.fn(() => ({ resumePromptMode: 'off' }));

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
      loadGroupPolicy,
    })).resolves.toBe('off');

    expect(loadGroupPolicy).toHaveBeenCalledTimes(1);
  });

  it('does not load group policy once explicit or persisted intent mode decides', async () => {
    const loadGroupPolicy = vi.fn(() => ({ resumePromptMode: 'off' }));

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'standard',
      loadGroupPolicy,
    })).resolves.toBe('standard');
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      existingIntent: offIntent,
      loadGroupPolicy,
    })).resolves.toBe('off');

    expect(loadGroupPolicy).not.toHaveBeenCalled();
  });

  it('falls through tiers on loader failure and on invalid values', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'sometimes',
      existingIntent: { resumePromptMode: 'later' },
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 42 } },
      loadGroupPolicy: () => {
        throw new Error('group fetch failed');
      },
    })).resolves.toBe('standard');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadGroupPolicy: async () => {
        throw new Error('group fetch failed');
      },
    })).resolves.toBe('standard');
  });

  it('resolves custom mode from any tier without falling through', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'custom',
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
    })).resolves.toBe('custom');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } },
      loadGroupPolicy: () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('off');
  });

  it('reads the account tier from both nested and flat settings shapes', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { resumePromptMode: 'off' },
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
    })).resolves.toBe('off');
  });
});

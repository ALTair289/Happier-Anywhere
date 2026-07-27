import { describe, expect, it } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import { resolveInactiveUsageLimitRecoverySchedulerResult } from './resolveInactiveUsageLimitRecoverySchedulerResult';

const metadata = {
  [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
    v: 1 as const,
    status: 'waiting' as const,
    issueFingerprint: 'limit',
    armedAtMs: 1_000,
    resetAtMs: 2_000,
    nextCheckAtMs: 2_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    resumePromptMode: 'standard' as const,
    selectedAuth: {
      kind: 'profile' as const,
      serviceId: 'openai-codex' as const,
      profileId: 'work',
    },
  },
};

describe('resolveInactiveUsageLimitRecoverySchedulerResult', () => {
  it('keeps provider-ready startup reconstruction passive', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'ready', metadata },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toEqual({
      status: 'pause',
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth,
    });
  });

  it('settles a same-daemon resume as effectfully completed', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'resumed', metadata },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toEqual({
      status: 'ready',
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth,
    });
  });
});

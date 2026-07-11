import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import {
  resolvePendingQueueRuntimeActivityDeferral,
  resolveSessionPendingActiveTurnDeliveryPolicy,
  resolveSessionPendingQueueDeliveryTiming,
  runtimeIdleForPendingDrain,
  shouldDeferPendingQueueDrainForRuntimeActivity,
} from './pendingQueueDrainPolicy';

describe('pendingQueueDrainPolicy delivery timing', () => {
  it('allows active-turn delivery unless the user explicitly chose server-pending busy sends', () => {
    expect(resolveSessionPendingActiveTurnDeliveryPolicy(null)).toBe('allow_live_delivery');
    expect(resolveSessionPendingActiveTurnDeliveryPolicy(accountSettingsParse({}))).toBe('allow_live_delivery');
    expect(resolveSessionPendingActiveTurnDeliveryPolicy(accountSettingsParse({
      sessionBusySteerSendPolicy: 'steer_immediately',
    }))).toBe('allow_live_delivery');
    expect(resolveSessionPendingActiveTurnDeliveryPolicy(accountSettingsParse({
      sessionBusySteerSendPolicy: 'server_pending',
    }))).toBeUndefined();
  });

  it('defaults queued delivery timing to foreground-ready materialization', () => {
    expect(resolveSessionPendingQueueDeliveryTiming(null)).toBe('after_foreground_ready');
    expect(resolveSessionPendingQueueDeliveryTiming(accountSettingsParse({}))).toBe('after_foreground_ready');
    expect(resolveSessionPendingQueueDeliveryTiming(accountSettingsParse({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    }))).toBe('after_runtime_idle');
  });

  it('treats active runtime activity with a valid future expiry as non-idle', () => {
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 1_000)).toBe(false);
  });

  it('fails open for null invalid or elapsed runtime activity expiry', () => {
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: Number.NaN,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 1_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 0.5,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000.5,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 1_000)).toBe(true);
  });

  it('treats elapsed projection expiry as idle when no runtime owner is known live', () => {
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 1_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 2_000)).toBe(true);
  });

  it.each([
    ['missing observed timestamp', { runtimeActivityObservedAt: null }],
    ['invalid observed timestamp', { runtimeActivityObservedAt: -1 }],
    ['missing source class', { runtimeActivitySourceClass: null }],
    ['unknown source class', { runtimeActivitySourceClass: 'provider_task:task-123' }],
  ])('treats active runtime activity with %s as non-idle when count and expiry are valid', (_label, overrides) => {
    expect(runtimeIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
      ...overrides,
    }, 1_000)).toBe(false);
  });

  it('does not impose a fixed max wait cap while renewed expiry remains future-valid', () => {
    const activity = {
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 3_599_000,
      runtimeActivityExpiresAt: 7_200_000,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
    };

    expect(runtimeIdleForPendingDrain(activity, 3_600_000)).toBe(false);
    expect(runtimeIdleForPendingDrain({
      ...activity,
      runtimeActivityObservedAt: 7_199_000,
      runtimeActivityExpiresAt: 10_800_000,
    }, 7_200_000)).toBe(false);
  });

  it('only defers queued delivery for after-runtime-idle timing with active runtime projection', () => {
    const activity = {
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
    };

    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: accountSettingsParse({}),
      activity,
      nowMs: 1_000,
    })).toBe(false);
    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      activity,
      nowMs: 1_000,
    })).toBe(true);
  });

  it('returns the runtime activity expiry wake even when the local runtime owner is live', () => {
    const activity = {
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
    };

    expect(resolvePendingQueueRuntimeActivityDeferral({
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      activity,
      nowMs: 1_000,
      ownerLive: true,
    })).toEqual({
      defer: true,
      runtimeActivityExpiresAt: 2_000,
    });
  });

  it('fails open for after-runtime-idle delivery when runtime owner activity expiry has elapsed', () => {
    const activity = {
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 1_000,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
    };

    expect(resolvePendingQueueRuntimeActivityDeferral({
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      activity,
      nowMs: 2_000,
      ownerLive: true,
    })).toEqual({
      defer: false,
      runtimeActivityExpiresAt: null,
    });
  });
});

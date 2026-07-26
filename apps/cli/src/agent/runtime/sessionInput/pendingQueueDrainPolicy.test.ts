import { describe, expect, it } from 'vitest';

import {
  resolvePendingRuntimeActivityDeferredReason,
  runtimeIdleForPendingDrain,
  shouldDeferPendingQueueDrainForRuntimeActivity,
} from './pendingQueueDrainPolicy';

describe('pending queue Runtime Activity admission', () => {
  it('allows only a complete idle target projection', () => {
    const idle = {
      runtimeActivityState: 'idle' as const,
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 2,
    };

    expect(runtimeIdleForPendingDrain(idle, 999)).toBe(true);
    expect(resolvePendingRuntimeActivityDeferredReason(idle, 999)).toBeNull();
  });

  it('fails closed for active, unknown, and incomplete projections', () => {
    expect(resolvePendingRuntimeActivityDeferredReason({
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 2,
    }, 999)).toBe('waiting_for_runtime_activity');
    expect(resolvePendingRuntimeActivityDeferredReason({
      runtimeActivityState: 'unknown',
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityRevision: 2,
    }, 999)).toBe('runtime_activity_unknown');
    expect(resolvePendingRuntimeActivityDeferredReason({}, 999)).toBe('runtime_activity_unknown');
  });

  it('applies Runtime Activity only to after-runtime-idle delivery timing', () => {
    const active = {
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 3,
    };
    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' },
      activity: active,
      nowMs: 999,
    })).toBe(true);
    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' },
      activity: active,
      nowMs: 999,
    })).toBe(false);
  });
});

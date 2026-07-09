import { describe, expect, it } from 'vitest';

import {
  PendingDeliveryBlockedReasonSchema,
  isPendingDeliveryBlockedReason,
  normalizePendingDeliveryBlockedReason,
  PENDING_DELIVERY_BLOCKED_REASONS,
} from './pendingDeliveryBlockedReason';

describe('pending delivery blocked reason contract', () => {
  it('accepts every published blocked reason', () => {
    for (const reason of PENDING_DELIVERY_BLOCKED_REASONS) {
      expect(PendingDeliveryBlockedReasonSchema.parse(reason)).toBe(reason);
      expect(isPendingDeliveryBlockedReason(reason)).toBe(true);
      expect(normalizePendingDeliveryBlockedReason(reason)).toBe(reason);
    }
  });

  it('accepts runtime config blockers as retryable pending delivery blocks', () => {
    expect(PendingDeliveryBlockedReasonSchema.parse('runtime_config_blocked')).toBe('runtime_config_blocked');
    expect(isPendingDeliveryBlockedReason('runtime_config_blocked')).toBe(true);
    expect(normalizePendingDeliveryBlockedReason('runtime_config_blocked')).toBe('runtime_config_blocked');
  });

  it('rejects missing and future blocked reasons', () => {
    expect(isPendingDeliveryBlockedReason('future_reason')).toBe(false);
    expect(normalizePendingDeliveryBlockedReason('future_reason')).toBeNull();
    expect(normalizePendingDeliveryBlockedReason(null)).toBeNull();
  });
});

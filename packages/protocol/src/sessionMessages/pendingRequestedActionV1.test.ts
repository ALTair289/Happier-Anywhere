import { describe, expect, it } from 'vitest';

import { PendingRequestedActionV1Schema } from './pendingRequestedActionV1.js';

describe('PendingRequestedActionV1Schema', () => {
  it.each(['enqueue', 'steer_if_active', 'steer_now', 'send_now'] as const)(
    'accepts the canonical %s row action without duplicating row identity',
    (kind) => {
      expect(PendingRequestedActionV1Schema.parse({ v: 1, kind })).toEqual({ v: 1, kind });
    },
  );

  it('rejects the removed exact-dispatch selector and command shape', () => {
    expect(PendingRequestedActionV1Schema.safeParse({
      v: 1,
      kind: 'send_now',
      selector: { kind: 'exact_target', localId: 'pending-1' },
      deliveryCommand: 'interrupt_and_send',
    }).success).toBe(false);
  });
});

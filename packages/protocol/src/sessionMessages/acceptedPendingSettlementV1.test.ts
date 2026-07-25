import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
  AcceptedPendingSettlementRequestV1Schema,
  AcceptedPendingSettlementResponseV1Schema,
} from './acceptedPendingSettlementV1.js';

describe('AcceptedPendingSettlementRequestV1Schema', () => {
  it('owns the exact current-publisher socket settlement request', () => {
    expect(ACCEPTED_PENDING_SETTLEMENT_EVENT_V1).toBe('pending-delivery-accepted-v1');
    expect(AcceptedPendingSettlementRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      localId: 'pending-1',
    })).toEqual({
      v: 1,
      sessionId: 'session-1',
      localId: 'pending-1',
    });
    expect(AcceptedPendingSettlementRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      localId: 'pending-1',
      token: 'user-auth-is-not-publisher-authority',
    }).success).toBe(false);

    const longOpaqueLocalId = `pending-${'x'.repeat(512)}`;
    expect(AcceptedPendingSettlementRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      localId: longOpaqueLocalId,
    }).localId).toBe(longOpaqueLocalId);
    expect(AcceptedPendingSettlementRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      localId: '   ',
    }).success).toBe(false);
    expect(AcceptedPendingSettlementRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      localId: ' pending-1 ',
    }).localId).toBe(' pending-1 ');
  });

  it('owns the exact settlement acknowledgement and rejects ambiguous success', () => {
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: false,
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 4,
    }).success).toBe(true);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: false,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 5,
      message: {
        id: 'message-1',
        seq: 7,
        localId: 'pending-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        deliveryResolution: { v: 1, kind: 'manual_handled' },
        createdAt: 1,
        updatedAt: 1,
      },
    }).success).toBe(true);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: false,
      error: 'transaction-unavailable',
      retryAfterMs: 1_000,
      correlationId: 'accepted-settlement-1',
    }).success).toBe(true);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 4,
    }).success).toBe(false);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: true,
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 4,
    }).success).toBe(false);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: true,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 4,
      message: {},
    }).success).toBe(false);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: true,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 4,
      message: {
        id: 'message-1',
        seq: 1,
        localId: 'pending-1',
        createdAt: 1,
        updatedAt: 1,
      },
    }).success).toBe(false);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: true,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 4,
      message: {
        id: ' \t ',
        seq: 1,
        localId: 'pending-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        createdAt: 1,
        updatedAt: 1,
      },
    }).success).toBe(false);
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: true,
      didResolve: true,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 4,
      message: {
        id: 'message-1',
        seq: Number.MAX_SAFE_INTEGER + 1,
        localId: 'pending-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        createdAt: 1,
        updatedAt: 1,
      },
    }).success).toBe(false);
  });
});

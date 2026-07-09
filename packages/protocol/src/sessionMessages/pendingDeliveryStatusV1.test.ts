import { describe, expect, it } from 'vitest';

import {
  isPendingDeliveryStatusTransitionAllowedV1,
  normalizePendingDeliveryStatusV1,
  parsePendingDeliveryStatusV1,
  pendingDeliveryStatusV1ToPersistedFields,
  type PendingDeliveryStatusTransitionTargetV1,
  type PendingDeliveryStatusV1,
} from './pendingDeliveryStatusV1';

describe('pending delivery status v1 contract', () => {
  it.each([
    [
      'queued row',
      { status: 'queued', deliveryState: null, deliveryBlockedReason: null },
      { status: 'queued' },
      { status: 'queued', deliveryState: null, deliveryBlockedReason: null, discardedReason: null },
    ],
    [
      'claimed provider row',
      { status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null },
      { status: 'delivering' },
      { status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null, discardedReason: null },
    ],
    [
      'blocked row',
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'terminal_composer_draft' },
      { status: 'blocked', reason: 'terminal_composer_draft' },
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'terminal_composer_draft', discardedReason: null },
    ],
    [
      'legacy blocked row without a valid reason',
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason' },
      { status: 'blocked', reason: 'unknown' },
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'unknown', discardedReason: null },
    ],
    [
      'discarded row',
      { status: 'discarded', deliveryState: 'blocked', deliveryBlockedReason: 'terminal_composer_draft', discardedReason: 'user dismissed' },
      { status: 'discarded', reason: 'user dismissed' },
      { status: 'discarded', deliveryState: null, deliveryBlockedReason: null, discardedReason: 'user dismissed' },
    ],
  ] satisfies readonly (readonly [
    string,
    Parameters<typeof normalizePendingDeliveryStatusV1>[0],
    PendingDeliveryStatusV1,
    ReturnType<typeof pendingDeliveryStatusV1ToPersistedFields>,
  ])[])('round-trips %s through the persisted column shape', (_name, fields, typed, persisted) => {
    expect(normalizePendingDeliveryStatusV1(fields)).toEqual(typed);
    expect(pendingDeliveryStatusV1ToPersistedFields(typed)).toEqual(persisted);
  });

  it('parses typed status values received from server projections', () => {
    expect(parsePendingDeliveryStatusV1({ status: 'delivering' })).toEqual({ status: 'delivering' });
    expect(parsePendingDeliveryStatusV1({ status: 'blocked', reason: 'payload_too_large' })).toEqual({
      status: 'blocked',
      reason: 'payload_too_large',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'blocked', reason: 'future_reason' })).toEqual({
      status: 'blocked',
      reason: 'unknown',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'discarded', reason: '' })).toEqual({
      status: 'discarded',
      reason: null,
    });
    expect(parsePendingDeliveryStatusV1({ status: 'resolved' })).toBeNull();
  });

  it.each([
    [{ status: 'queued' }, { status: 'resolved', reason: 'provider_accepted' }, false],
    [{ status: 'delivering' }, { status: 'resolved', reason: 'provider_accepted' }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'resolved', reason: 'provider_accepted' }, false],
    [{ status: 'queued' }, { status: 'resolved', reason: 'provider_accepted', acceptedThroughSeq: true }, false],
    [{ status: 'delivering' }, { status: 'resolved', reason: 'provider_accepted', acceptedThroughSeq: true }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'resolved', reason: 'provider_accepted', acceptedThroughSeq: true }, true],
    [{ status: 'queued' }, { status: 'resolved', reason: 'materialized' }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'queued' }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'blocked', reason: 'payload_too_large' }, true],
    [{ status: 'discarded', reason: null }, { status: 'delivering' }, false],
  ] satisfies readonly (readonly [PendingDeliveryStatusV1, PendingDeliveryStatusTransitionTargetV1, boolean])[])(
    'validates %# transition',
    (from, to, allowed) => {
      expect(isPendingDeliveryStatusTransitionAllowedV1(from, to)).toBe(allowed);
    },
  );
});

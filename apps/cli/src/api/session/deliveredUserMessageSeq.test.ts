import { describe, expect, it } from 'vitest';

import {
  clampAttachCursorToDeliveredUserMessageSeq,
  mergeDeliveredUserMessageSeqV1,
  mergeProviderAcceptedUserMessageSeqV1,
  mergeUserMessageDeliveryWatermarkModeV1,
  readDeliveredUserMessageSeqV1,
  readProviderAcceptedUserMessageSeqV1,
  readUserMessageDeliveryWatermarkModeV1,
  resolveAttachCursorForUserMessageDeliveryWatermark,
} from './deliveredUserMessageSeq';

describe('readDeliveredUserMessageSeqV1', () => {
  it('reads a non-negative integer watermark from metadata', () => {
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 4 })).toBe(4);
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 0 })).toBe(0);
  });

  it('returns null for missing or malformed values (fail to legacy behavior)', () => {
    expect(readDeliveredUserMessageSeqV1(null)).toBeNull();
    expect(readDeliveredUserMessageSeqV1({})).toBeNull();
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: -1 })).toBeNull();
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 1.5 })).toBeNull();
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: '4' })).toBeNull();
  });
});

describe('readProviderAcceptedUserMessageSeqV1', () => {
  it('reads a non-negative integer provider-accepted watermark from metadata', () => {
    expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: 4 })).toBe(4);
    expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: 0 })).toBe(0);
  });

  it('returns null for missing or malformed provider-accepted values', () => {
    expect(readProviderAcceptedUserMessageSeqV1(null)).toBeNull();
    expect(readProviderAcceptedUserMessageSeqV1({})).toBeNull();
    expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: -1 })).toBeNull();
    expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: 1.5 })).toBeNull();
    expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: '4' })).toBeNull();
  });
});

describe('mergeDeliveredUserMessageSeqV1', () => {
  it('advances the watermark', () => {
    expect(mergeDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 4 } as never, 7)).toEqual({
      changed: true,
      metadata: { deliveredUserMessageSeqV1: 7 },
    });
  });

  it('sets the watermark when absent', () => {
    const out = mergeDeliveredUserMessageSeqV1({} as never, 3);
    expect(out.changed).toBe(true);
    expect(out.metadata).toMatchObject({ deliveredUserMessageSeqV1: 3 });
  });

  it('never regresses the watermark', () => {
    const metadata = { deliveredUserMessageSeqV1: 9 } as never;
    expect(mergeDeliveredUserMessageSeqV1(metadata, 4)).toEqual({ changed: false, metadata });
  });
});

describe('mergeProviderAcceptedUserMessageSeqV1', () => {
  it('advances the provider-accepted watermark without rewriting the legacy delivered cursor', () => {
    expect(mergeProviderAcceptedUserMessageSeqV1({ deliveredUserMessageSeqV1: 2, providerAcceptedUserMessageSeqV1: 4 } as never, 7)).toEqual({
      changed: true,
      metadata: { deliveredUserMessageSeqV1: 2, providerAcceptedUserMessageSeqV1: 7 },
    });
  });

  it('sets the provider-accepted watermark when absent', () => {
    const out = mergeProviderAcceptedUserMessageSeqV1({ deliveredUserMessageSeqV1: 3 } as never, 5);
    expect(out.changed).toBe(true);
    expect(out.metadata).toMatchObject({
      deliveredUserMessageSeqV1: 3,
      providerAcceptedUserMessageSeqV1: 5,
    });
  });

  it('never regresses the provider-accepted watermark', () => {
    const metadata = { providerAcceptedUserMessageSeqV1: 9 } as never;
    expect(mergeProviderAcceptedUserMessageSeqV1(metadata, 4)).toEqual({ changed: false, metadata });
  });
});

describe('clampAttachCursorToDeliveredUserMessageSeq', () => {
  it('clamps the attach cursor down to the delivered watermark (owed rows redelivered)', () => {
    expect(clampAttachCursorToDeliveredUserMessageSeq(42, 4)).toBe(4);
  });

  it('keeps the cursor when the watermark is not lower', () => {
    expect(clampAttachCursorToDeliveredUserMessageSeq(4, 42)).toBe(4);
    expect(clampAttachCursorToDeliveredUserMessageSeq(4, 4)).toBe(4);
  });

  it('keeps the cursor when no watermark exists (legacy sessions)', () => {
    expect(clampAttachCursorToDeliveredUserMessageSeq(42, null)).toBe(42);
    expect(clampAttachCursorToDeliveredUserMessageSeq(undefined, 4)).toBeUndefined();
  });
});

describe('userMessageDeliveryWatermarkModeV1', () => {
  it('reads only supported watermark modes', () => {
    expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: 'queueHandoff' })).toBe('queueHandoff');
    expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: 'providerAcceptance' })).toBe('providerAcceptance');
    expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: 'provider' })).toBeNull();
    expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: null })).toBeNull();
    expect(readUserMessageDeliveryWatermarkModeV1(null)).toBeNull();
  });

  it('records a supported watermark mode without rewriting an unchanged value', () => {
    const first = mergeUserMessageDeliveryWatermarkModeV1({} as never, 'providerAcceptance');
    expect(first.changed).toBe(true);
    expect(first.metadata).toEqual({ userMessageDeliveryWatermarkModeV1: 'providerAcceptance' });

    const unchanged = mergeUserMessageDeliveryWatermarkModeV1(first.metadata, 'providerAcceptance');
    expect(unchanged.changed).toBe(false);
    expect(unchanged.metadata).toBe(first.metadata);
  });
});

describe('resolveAttachCursorForUserMessageDeliveryWatermark', () => {
  it('uses queue-delivery metadata for queue-handoff sessions', () => {
    expect(resolveAttachCursorForUserMessageDeliveryWatermark({
      cursor: 42,
      mode: 'queueHandoff',
      deliveredUserMessageSeq: 5,
      providerAcceptedUserMessageSeq: 3,
    })).toEqual({ cursor: 5, effectiveWatermarkSeq: 5 });
  });

  it('uses only provider-accepted custody for provider-acceptance sessions', () => {
    expect(resolveAttachCursorForUserMessageDeliveryWatermark({
      cursor: 42,
      mode: 'providerAcceptance',
      deliveredUserMessageSeq: 5,
      providerAcceptedUserMessageSeq: 3,
    })).toEqual({ cursor: 3, effectiveWatermarkSeq: 3 });
  });

  it('replays from the beginning when provider-acceptance sessions lack explicit custody', () => {
    expect(resolveAttachCursorForUserMessageDeliveryWatermark({
      cursor: 42,
      mode: 'providerAcceptance',
      deliveredUserMessageSeq: 5,
      providerAcceptedUserMessageSeq: null,
    })).toEqual({ cursor: 0, effectiveWatermarkSeq: 0 });
  });
});

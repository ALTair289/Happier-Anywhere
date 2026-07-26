import { describe, expect, it } from 'vitest';

import {
  acceptLivePublication,
  createLiveDeliveryState,
  disposeLiveDeliveryState,
  queueLiveDeliveryIntent,
  recordLiveDeliveryFailure,
  takePendingLiveDeliveryIntent,
} from './liveDeliveryState';

describe('liveDeliveryState', () => {
  it('does not let a late in-flight acceptance resurrect disposed segment state', () => {
    const state = createLiveDeliveryState();
    disposeLiveDeliveryState(state);

    const accepted = acceptLivePublication({
      delivery: state,
      text: 'late text',
      tick: 1,
      outcome: { accepted: true, epoch: 3 },
      attemptedEpoch: 3,
      acceptedAtMs: 100,
      wasCheckpoint: true,
    });

    expect(accepted).toBe(false);
    expect(state.locallyAccepted).toBeNull();
  });

  it('does not retain a late in-flight failure after segment disposal', () => {
    const state = createLiveDeliveryState();
    disposeLiveDeliveryState(state);

    recordLiveDeliveryFailure({
      delivery: state,
      reason: {
        code: 'local_failure',
        error: { name: 'Error', message: 'late failure' },
      },
      nowMs: 100,
    });

    expect(state.failure).toBeNull();
    expect(state.checkpointRequired).toBe(false);
  });

  it('keeps a queued terminal intent authoritative over a later streaming request', () => {
    const state = createLiveDeliveryState();
    queueLiveDeliveryIntent(state, { state: 'complete' });
    queueLiveDeliveryIntent(state, { state: 'streaming' });

    expect(takePendingLiveDeliveryIntent(state)).toEqual({ state: 'complete' });
  });

  it('retains the first structured failure while suppressing repeated identical diagnostics', () => {
    const state = createLiveDeliveryState();
    const firstReason = {
      code: 'local_failure' as const,
      error: { name: 'TypeError', message: 'first failure' },
    };

    const first = recordLiveDeliveryFailure({ delivery: state, reason: firstReason, nowMs: 100 });
    const repeated = recordLiveDeliveryFailure({ delivery: state, reason: firstReason, nowMs: 200 });

    expect(first).toMatchObject({ logFull: true, firstReason, count: 1 });
    expect(repeated).toMatchObject({ logFull: false, firstReason, count: 2 });
    expect(state.failure).toMatchObject({
      firstReason,
      count: 2,
      suppressedCount: 1,
    });
    expect(state.checkpointRequired).toBe(true);
  });
});

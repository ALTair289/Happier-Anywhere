import { afterEach, describe, expect, it, vi } from 'vitest';

import { decideRuntimeIdleAdmission } from './admission.js';
import { SessionRuntimeActivityProjectionSchema } from './projection.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('decideRuntimeIdleAdmission', () => {
  it.each([1, 17, Number.MAX_SAFE_INTEGER])(
    'allows idle with exact revision %s',
    (revision) => {
      const projection = SessionRuntimeActivityProjectionSchema.parse({
        state: 'idle',
        activeCount: 0,
        observedAt: 100,
        revision,
      });

      expect(decideRuntimeIdleAdmission(projection)).toEqual({
        decision: 'allow',
        revision,
      });
    },
  );

  it('defers active with its exact reason and revision', () => {
    const projection = SessionRuntimeActivityProjectionSchema.parse({
      state: 'active',
      activeCount: 2,
      observedAt: 1_000,
      revision: 23,
    });

    expect(decideRuntimeIdleAdmission(projection)).toEqual({
      decision: 'defer',
      reason: 'active',
      revision: 23,
    });
  });

  it('defers unknown with its exact reason and revision', () => {
    const projection = SessionRuntimeActivityProjectionSchema.parse({
      state: 'unknown',
      activeCount: 0,
      observedAt: 2_000,
      revision: 29,
    });

    expect(decideRuntimeIdleAdmission(projection)).toEqual({
      decision: 'defer',
      reason: 'unknown',
      revision: 29,
    });
  });

  it('is independent of observed time and clock advancement', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const firstProjection = SessionRuntimeActivityProjectionSchema.parse({
      state: 'unknown',
      activeCount: 0,
      observedAt: null,
      revision: 31,
    });
    const firstDecision = decideRuntimeIdleAdmission(firstProjection);

    vi.setSystemTime(1_000_000);
    const laterProjection = SessionRuntimeActivityProjectionSchema.parse({
      ...firstProjection,
      observedAt: 999_999,
    });

    expect(decideRuntimeIdleAdmission(laterProjection)).toEqual(firstDecision);
    expect(firstDecision).toEqual({
      decision: 'defer',
      reason: 'unknown',
      revision: 31,
    });
  });
});

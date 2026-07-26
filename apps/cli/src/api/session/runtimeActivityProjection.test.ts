import { describe, expect, it } from 'vitest';

import {
  hasSessionRuntimeActivityProjectionBoundaryEvidence,
  readSessionRuntimeActivityProjectionBoundary,
} from './runtimeActivityProjection';

describe('session Runtime Activity projection boundary', () => {
  it('accepts one complete exact projection tuple', () => {
    expect(readSessionRuntimeActivityProjectionBoundary({
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 3,
    })).toEqual({
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 3,
    });
  });

  it('rejects the superseded sourceClass sibling instead of accepting a reconstructed tuple', () => {
    const projection = readSessionRuntimeActivityProjectionBoundary({
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 3,
      runtimeActivitySourceClass: 'agent_detached_task',
    });

    expect(projection).toEqual({});
    expect(hasSessionRuntimeActivityProjectionBoundaryEvidence(projection)).toBe(false);
  });
});

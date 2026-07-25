import { describe, expect, it } from 'vitest';

import {
  SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX,
  SessionRuntimeActivityActiveCountSchema,
  mergeSessionRuntimeActivityProjection,
  parseSessionRuntimeActivityProjectionFields,
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
  SessionRuntimeActivityStateSchema,
} from './projection.js';

describe('SessionRuntimeActivity projection contract', () => {
  it('freezes the public state and active-count vocabulary', () => {
    expect(SessionRuntimeActivityStateSchema.options).toEqual(['active', 'idle', 'unknown']);
    expect(SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX).toBe(2_147_483_647);
    expect(SessionRuntimeActivityActiveCountSchema.parse(2_147_483_647)).toBe(
      2_147_483_647,
    );
  });

  it.each([
    { state: 'active', activeCount: 1 },
    { state: 'active', activeCount: SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX },
    { state: 'idle', activeCount: 0 },
    { state: 'unknown', activeCount: 0 },
  ])('accepts the complete snapshot tuple $state/$activeCount', (snapshot) => {
    expect(SessionRuntimeActivitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    { state: 'active', activeCount: 0 },
    { state: 'idle', activeCount: 1 },
    { state: 'unknown', activeCount: 1 },
  ])('rejects contradictory snapshot tuple %#', (snapshot) => {
    expect(SessionRuntimeActivitySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it.each([
    -1,
    0.5,
    SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX + 1,
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid active count %s', (activeCount) => {
    expect(SessionRuntimeActivityActiveCountSchema.safeParse(activeCount).success).toBe(false);
  });

  it.each([
    ['revision', 1],
    ['observedAt', 1],
    ['v', 1],
    ['version', 1],
    ['expiresAt', 1],
    ['lease', 'lease-1'],
    ['sourceId', 'source-1'],
    ['sources', []],
    ['owner', 'owner-1'],
    ['generation', 1],
    ['credential', 'secret'],
    ['capabilities', []],
    ['receipt', 'receipt-1'],
    ['connectionReady', true],
  ])('rejects server, legacy, or private snapshot field %s', (field, value) => {
    const snapshot = {
      state: 'idle',
      activeCount: 0,
      [field]: value,
    };

    expect(SessionRuntimeActivitySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it.each([
    { activeCount: 0 },
    { state: 'idle' },
  ])('rejects incomplete snapshot %#', (snapshot) => {
    expect(SessionRuntimeActivitySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('treats own optional keys with undefined values as absent while rejecting real partial tuples', () => {
    expect(parseSessionRuntimeActivityProjectionFields({
      runtimeActivityState: undefined,
      runtimeActivityActiveCount: undefined,
      runtimeActivityObservedAt: undefined,
      runtimeActivityRevision: undefined,
    })).toEqual({ kind: 'absent' });
    expect(parseSessionRuntimeActivityProjectionFields({
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: undefined,
      runtimeActivityObservedAt: undefined,
      runtimeActivityRevision: undefined,
    })).toEqual({ kind: 'invalid' });
  });

  it.each([
    {
      state: 'active',
      activeCount: SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX,
      observedAt: Number.MAX_SAFE_INTEGER,
      revision: Number.MAX_SAFE_INTEGER,
    },
    { state: 'unknown', activeCount: 0, observedAt: null, revision: 0 },
    { state: 'unknown', activeCount: 0, observedAt: null, revision: 7 },
    { state: 'unknown', activeCount: 0, observedAt: 0, revision: 1 },
    { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 },
  ])('accepts valid server projection %#', (projection) => {
    expect(SessionRuntimeActivityProjectionSchema.parse(projection)).toEqual(projection);
  });

  it.each([
    { field: 'observedAt', value: -1 },
    { field: 'observedAt', value: 0.5 },
    { field: 'observedAt', value: Number.MAX_SAFE_INTEGER + 1 },
    { field: 'revision', value: -1 },
    { field: 'revision', value: 0.5 },
    { field: 'revision', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid projection $field=$value', ({ field, value }) => {
    const projection = {
      state: 'idle',
      activeCount: 0,
      observedAt: 1,
      revision: 1,
      [field]: value,
    };

    expect(SessionRuntimeActivityProjectionSchema.safeParse(projection).success).toBe(false);
  });

  it('rejects malformed projections rather than normalizing them to idle', () => {
    const result = SessionRuntimeActivityProjectionSchema.safeParse({
      state: 'active',
      activeCount: 0,
      observedAt: null,
      revision: 0,
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown projection fields', () => {
    expect(SessionRuntimeActivityProjectionSchema.safeParse({
      state: 'idle',
      activeCount: 0,
      observedAt: 1,
      revision: 1,
      writerGeneration: 1,
    }).success).toBe(false);
  });

  it.each([
    { state: 'active', activeCount: 1, observedAt: null, revision: 1 },
    { state: 'idle', activeCount: 0, observedAt: null, revision: 1 },
    { state: 'idle', activeCount: 0, observedAt: 1, revision: 0 },
    { state: 'active', activeCount: 1, observedAt: 1, revision: 0 },
  ])('rejects non-sentinel null timestamps and non-baseline revision zero %#', (projection) => {
    expect(SessionRuntimeActivityProjectionSchema.safeParse(projection).success).toBe(false);
  });

  it('orders complete projections only by revision and permits observedAt regression', () => {
    const current = {
      state: 'active' as const,
      activeCount: 2,
      observedAt: 500,
      revision: 7,
    };

    expect(mergeSessionRuntimeActivityProjection(current, {
      state: 'idle',
      activeCount: 0,
      observedAt: 400,
      revision: 8,
    })).toEqual({
      decision: 'replace',
      projection: {
        state: 'idle',
        activeCount: 0,
        observedAt: 400,
        revision: 8,
      },
    });
    expect(mergeSessionRuntimeActivityProjection(current, {
      state: 'idle',
      activeCount: 0,
      observedAt: 900,
      revision: 6,
    })).toEqual({ decision: 'ignore_stale', projection: current });
  });

  it('is idempotent for equal identical tuples and requests resync for equal conflicts', () => {
    const current = {
      state: 'active' as const,
      activeCount: 2,
      observedAt: 500,
      revision: 7,
    };

    expect(mergeSessionRuntimeActivityProjection(current, { ...current })).toEqual({
      decision: 'ignore_identical',
      projection: current,
    });
    expect(mergeSessionRuntimeActivityProjection(current, {
      state: 'idle',
      activeCount: 0,
      observedAt: 501,
      revision: 7,
    })).toEqual({
      decision: 'resync_conflict',
      projection: current,
    });
  });

  it('rejects malformed or partial input before revision comparison without advancing truth', () => {
    const current = {
      state: 'active' as const,
      activeCount: 2,
      observedAt: 500,
      revision: 7,
    };

    for (const incoming of [
      { state: 'idle', activeCount: 0, revision: 8 },
      { state: 'active', activeCount: 0, observedAt: 600, revision: 8 },
      { state: 'idle', activeCount: 0, observedAt: 600, revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(mergeSessionRuntimeActivityProjection(current, incoming)).toEqual({
        decision: 'reject_invalid',
        projection: current,
      });
    }
  });
});

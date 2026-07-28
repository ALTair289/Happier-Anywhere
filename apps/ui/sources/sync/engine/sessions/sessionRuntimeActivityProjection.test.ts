import { describe, expect, it, vi } from 'vitest';

import {
    buildSessionRuntimeActivityProjectionPatch,
    resolveSessionRuntimeActivityProjectionFields,
} from './sessionRuntimeActivityProjection';

describe('sessionRuntimeActivityProjection', () => {
    const active = {
        runtimeActivityState: 'active' as const,
        runtimeActivityActiveCount: 2,
        runtimeActivityObservedAt: 300,
        runtimeActivityRevision: 7,
    };

    it('reads one complete four-field projection and preserves unknown', () => {
        expect(resolveSessionRuntimeActivityProjectionFields({}, active)).toEqual(active);
        expect(resolveSessionRuntimeActivityProjectionFields({}, {
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 301,
            runtimeActivityRevision: 8,
        })).toEqual({
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 301,
            runtimeActivityRevision: 8,
        });
    });

    it('keeps Activity absent when the boundary is absent, partial, malformed, or superseded', () => {
        for (const update of [
            {},
            { runtimeActivityActiveCount: 3, runtimeActivityRevision: 8 },
            {
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 301,
                runtimeActivityRevision: 8,
            },
            {
                ...active,
                runtimeActivitySourceClass: 'agent_detached_task',
            },
        ]) {
            expect(resolveSessionRuntimeActivityProjectionFields({}, update)).toEqual({});
        }
    });

    it('atomically replaces a higher revision even when observedAt regresses', () => {
        expect(buildSessionRuntimeActivityProjectionPatch(active, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 200,
            runtimeActivityRevision: 8,
        })).toEqual({
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 200,
            runtimeActivityRevision: 8,
        });
    });

    it('ignores stale and equal-identical updates without rebuilding state', () => {
        expect(buildSessionRuntimeActivityProjectionPatch(active, {
            ...active,
            runtimeActivityRevision: 6,
        })).toEqual({});
        expect(buildSessionRuntimeActivityProjectionPatch(active, { ...active })).toEqual({});
    });

    it('retains current truth and emits the typed resync trigger for equal-revision conflict', () => {
        const onResyncRequired = vi.fn();
        expect(buildSessionRuntimeActivityProjectionPatch(active, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 301,
            runtimeActivityRevision: 7,
        }, onResyncRequired)).toEqual({});
        expect(onResyncRequired).toHaveBeenCalledWith({
            reason: 'equal_revision_conflict',
            current: {
                state: 'active',
                activeCount: 2,
                observedAt: 300,
                revision: 7,
            },
            incoming: {
                state: 'idle',
                activeCount: 0,
                observedAt: 301,
                revision: 7,
            },
        });
    });

    it('rejects malformed higher revisions before ordering without watermark advance', () => {
        expect(buildSessionRuntimeActivityProjectionPatch(active, {
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 999,
            runtimeActivityRevision: 999,
        })).toEqual({});
    });
});

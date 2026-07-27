import { describe, expect, it } from 'vitest';

import {
    deriveSessionRuntimePresentationState,
    resolveNextSessionRuntimePresentationFreshnessAtMs,
} from './deriveSessionRuntimePresentationState';

describe('deriveSessionRuntimePresentationState', () => {
    const nowMs = 1_000_000;

    it('gives a foreground in-progress turn precedence over background activity', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 1,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            working: true,
            backgroundActive: false,
            activityState: 'working',
        });
    });

    it('keeps runtime activity background-active through arbitrary silence without a clock wake', () => {
        const input = {
            active: false,
            presence: 1,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: 1,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1,
            runtimeActivityRevision: 7,
        };

        expect(deriveSessionRuntimePresentationState(input, Number.MAX_SAFE_INTEGER)).toMatchObject({
            working: false,
            backgroundActive: true,
            activityState: 'backgroundActive',
        });
        expect(resolveNextSessionRuntimePresentationFreshnessAtMs(input, Number.MAX_SAFE_INTEGER)).toBeNull();
    });

    it('keeps unknown runtime activity quiet', () => {
        expect(deriveSessionRuntimePresentationState({
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 8,
        }, nowMs)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
    });

    it('presents canonical idle as calm idle', () => {
        expect(deriveSessionRuntimePresentationState({
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 100,
            runtimeActivityRevision: 9,
        }, nowMs)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
    });

    it('fails inconsistent downstream projection fields closed to quiet idle', () => {
        expect(deriveSessionRuntimePresentationState({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 0,
        }, nowMs).activityState).toBe('idle');
    });

    it('does not read sourceClass or let it classify runtime activity as foreground work', () => {
        const input = {
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            get runtimeActivitySourceClass(): never {
                throw new Error('runtime presentation must not read sourceClass');
            },
        };

        expect(deriveSessionRuntimePresentationState(input, nowMs)).toMatchObject({
            freshProviderRuntimeActivity: true,
            working: false,
            backgroundActive: true,
            activityState: 'backgroundActive',
        });
    });

    it('keeps terminal turn state authoritative over legacy thinking', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
        }, nowMs).working).toBe(false);
    });

    it('keeps pending permission attention foreground-freshness-owned', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - 1,
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
        }, nowMs).freshPermissionRequired).toBe(true);
    });

    it('never presents archived sessions as foreground or background work', () => {
        expect(deriveSessionRuntimePresentationState({
            archivedAt: nowMs,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        }, nowMs)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
    });
});

import { describe, expect, it } from 'vitest';

import {
    INVALID_NATIVE_OFFSET_RECOVERY_DURATION_MS,
    INVALID_NATIVE_OFFSET_RECOVERY_RAW_THRESHOLD_PX,
    createTranscriptBlankRecoveryState,
    planTranscriptBlankRecoveryObservation,
} from './blankRecoveryOwner';

const baseObservation = {
    bottomFollowMode: 'following' as const,
    contentPresent: true,
    entryRestoreOpen: false,
    gestureActive: false,
    hasVisibleRows: true,
    nowMs: 1_000,
    prependOpen: false,
    sessionId: 'session-1',
};

describe('blankRecoveryOwner', () => {
    it('authorizes exactly one scheduler-routed recovery after a sustained invalid native offset', () => {
        let state = createTranscriptBlankRecoveryState();
        let plan = planTranscriptBlankRecoveryObservation(state, {
            ...baseObservation,
            observationReason: 'invalid-native-offset',
            rawOffsetY: INVALID_NATIVE_OFFSET_RECOVERY_RAW_THRESHOLD_PX - 1,
        });
        expect(plan.effects).toEqual([]);

        state = plan.state;
        plan = planTranscriptBlankRecoveryObservation(state, {
            ...baseObservation,
            nowMs: baseObservation.nowMs + INVALID_NATIVE_OFFSET_RECOVERY_DURATION_MS,
            observationReason: 'invalid-native-offset',
            rawOffsetY: INVALID_NATIVE_OFFSET_RECOVERY_RAW_THRESHOLD_PX - 1,
        });
        expect(plan.effects).toEqual([{
            recovery: 'invalid-native-offset',
            reason: 'passive-drift',
            type: 'request-bottom-follow-write',
            writer: 'passive-drift',
        }]);

        state = plan.state;
        plan = planTranscriptBlankRecoveryObservation(state, {
            ...baseObservation,
            nowMs: baseObservation.nowMs + INVALID_NATIVE_OFFSET_RECOVERY_DURATION_MS + 50,
            observationReason: 'invalid-native-offset',
            rawOffsetY: -995_030,
        });
        expect(plan.effects).toEqual([]);
    });

    it('ignores normal overscroll bounce invalid-offset tags', () => {
        const plan = planTranscriptBlankRecoveryObservation(createTranscriptBlankRecoveryState(), {
            ...baseObservation,
            observationReason: 'invalid-native-offset',
            rawOffsetY: -15,
        });

        expect(plan.effects).toEqual([]);
        expect(INVALID_NATIVE_OFFSET_RECOVERY_RAW_THRESHOLD_PX).toBeLessThan(-15);
    });

    it('recovers an empty visible window only after the deadline and chooses bottom follow vs anchor restore', () => {
        let state = createTranscriptBlankRecoveryState();
        let plan = planTranscriptBlankRecoveryObservation(state, {
            ...baseObservation,
            hasVisibleRows: false,
            nowMs: 2_000,
        });
        expect(plan.effects).toEqual([]);

        state = plan.state;
        plan = planTranscriptBlankRecoveryObservation(state, {
            ...baseObservation,
            bottomFollowMode: 'released',
            hasVisibleRows: false,
            nowMs: 2_600,
        });
        expect(plan.effects).toEqual([{
            recovery: 'empty-visible-window',
            type: 'request-anchor-restore',
        }]);

        state = createTranscriptBlankRecoveryState();
        plan = planTranscriptBlankRecoveryObservation(state, {
            ...baseObservation,
            bottomFollowMode: 'following',
            hasVisibleRows: false,
            nowMs: 2_000,
        });
        plan = planTranscriptBlankRecoveryObservation(plan.state, {
            ...baseObservation,
            bottomFollowMode: 'following',
            hasVisibleRows: false,
            nowMs: 2_600,
        });
        expect(plan.effects).toEqual([{
            recovery: 'empty-visible-window',
            reason: 'passive-drift',
            type: 'request-bottom-follow-write',
            writer: 'passive-drift',
        }]);
    });

    it('does not arm recovery during entry/prepend transactions or active gestures', () => {
        for (const blocked of [
            { entryRestoreOpen: true },
            { prependOpen: true },
            { gestureActive: true },
        ]) {
            let plan = planTranscriptBlankRecoveryObservation(createTranscriptBlankRecoveryState(), {
                ...baseObservation,
                ...blocked,
                hasVisibleRows: false,
                observationReason: 'invalid-native-offset',
                rawOffsetY: -995_030,
            });
            plan = planTranscriptBlankRecoveryObservation(plan.state, {
                ...baseObservation,
                nowMs: baseObservation.nowMs + INVALID_NATIVE_OFFSET_RECOVERY_DURATION_MS + 1,
                observationReason: 'invalid-native-offset',
                rawOffsetY: -995_030,
            });
            expect(plan.effects).toEqual([]);
        }
    });
});

import { describe, expect, it } from 'vitest';

import {
    createEntryRestoreOwner,
    type EntryRestoreOwner,
    type EntryRestoreOwnerAttemptInput,
    type EntryRestoreOwnerEffect,
} from './entryRestoreOwner';

const anchor = {
    kind: 'message' as const,
    itemId: 'msg:m-20',
    messageId: 'm-20',
    itemOffsetPx: 84,
};

const targetAnchor = {
    kind: 'message' as const,
    itemId: 'msg:m-20',
    messageId: 'm-20',
};

const baseAttempt = {
    canMaterializeOlder: false,
    contentHeight: 2400,
    currentSessionId: 'session-a',
    deadlineMs: 1500,
    exactAnchorIndex: 2,
    fillSettled: true,
    items: [{ id: 'msg:m-10' }, { id: 'msg:m-15' }, { id: 'msg:m-20' }],
    jumpToSeqActive: false,
    layoutHeight: 600,
    nearestAnchorIndex: null,
    nowMs: 1000,
    platform: 'native' as const,
    restoredViewport: {
        anchor,
        offsetY: 120,
        sessionId: 'session-a',
        shouldFollowBottom: false,
    },
    slice: { capable: false as const },
    userScrollObserved: false,
} satisfies EntryRestoreOwnerAttemptInput<Readonly<{ id: string }>>;

function effectTypes(effects: readonly EntryRestoreOwnerEffect[]): readonly EntryRestoreOwnerEffect['type'][] {
    return effects.map((effect) => effect.type);
}

function executeEffects(effects: readonly EntryRestoreOwnerEffect[]) {
    return effects.filter((effect) => effect.type === 'execute-command');
}

describe('entry restore owner', () => {
    it('attempt anchored native entry opens the transaction and returns one semantic restore-anchor command', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt(baseAttempt);

        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    anchor: targetAnchor,
                    itemOffsetPx: 84,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-anchor',
                },
                type: 'execute-command',
            },
        ]);
        expect(effectTypes(effects)).toEqual([
            'execute-command',
            'schedule-entry-deadline',
            'set-native-initial-viewport-pending-observation',
            'record-restore-decision',
        ]);
        expect(owner.telemetryState('session-a')).toBe('open');
        expect(owner.nativePaintReleaseHandle({ sessionId: 'session-a' })).toEqual({
            issuedAtMs: 1000,
        });
        expect(owner.matchesNativePaintReleaseHandle({
            issuedAtMs: 1000,
            sessionId: 'session-a',
        })).toBe(true);
        expect(owner.visibleDistanceForOpenNativeEntry({
            observedDistanceFromBottom: 40,
            sessionId: 'session-a',
        })).toBe(120);
    });

    it('content and layout churn after the initial write does not reissue entry restore', () => {
        const owner = createEntryRestoreOwner();

        owner.attempt(baseAttempt);
        const retryEffects = owner.attempt({
            ...baseAttempt,
            contentHeight: 2600,
            layoutHeight: 640,
            nowMs: 1100,
        });

        expect(executeEffects(retryEffects)).toEqual([]);
        expect(owner.telemetryState('session-a')).toBe('open');
    });

    it('degrades identity-rotted anchors without durable seq to distance instead of materializing older pages', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            canMaterializeOlder: true,
            exactAnchorIndex: null,
            nearestAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: {
                    kind: 'toolGroup',
                    itemId: 'runtime-tool-group',
                    messageId: 'rotated-tool-id',
                    itemOffsetPx: 24,
                },
                offsetY: 300,
            },
        });

        expect(effectTypes(effects)).not.toContain('request-bounded-materialization');
        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    animated: undefined,
                    contentHeight: 2400,
                    distanceFromLiveTailPx: 300,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);
    });

    it('native conclusive misalignment spends exactly one correction and then holds ownership', () => {
        const owner = createEntryRestoreOwner();

        owner.attempt({
            ...baseAttempt,
            exactAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: null,
            },
        });

        const first = owner.observeNative({
            contentHeight: 2500,
            layoutHeight: 600,
            nowMs: 1050,
            observation: { status: 'misaligned' },
            sessionId: 'session-a',
        });
        const second = owner.observeNative({
            contentHeight: 2600,
            layoutHeight: 600,
            nowMs: 1180,
            observation: { status: 'misaligned' },
            sessionId: 'session-a',
        });

        expect(executeEffects(first)).toEqual([
            {
                command: {
                    animated: false,
                    contentHeight: 2500,
                    distanceFromLiveTailPx: 120,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);
        expect(executeEffects(second)).toEqual([]);
        expect(owner.telemetryState('session-a')).toBe('open');
    });

    it('observe-only slice entry never emits a scroll command and reveals slice on close', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            exactAnchorIndex: null,
            slice: {
                anchorRowId: 'msg:m-20',
                capable: true,
                renderedAnchor: anchor,
                renderedAnchorIndex: 2,
                target: {
                    anchorItemOffsetPx: 84,
                    anchorMessageId: 'm-20',
                    anchorSeq: 20,
                    kind: 'slice',
                },
                writeFree: true,
            },
        });

        expect(executeEffects(effects)).toEqual([]);
        expect(effectTypes(effects)).toContain('set-entry-slice-window');

        const closed = owner.observeNative({
            contentHeight: 2400,
            layoutHeight: 600,
            nowMs: 1100,
            observation: { status: 'aligned' },
            sessionId: 'session-a',
        });

        expect(executeEffects(closed)).toEqual([]);
        expect(effectTypes(closed)).toEqual([
            'clear-entry-deadline',
            'close-entry-ownership',
            'record-restore-decision',
            'native-initial-viewport-applied',
            'reveal-entry-slice-window',
        ]);
        expect(owner.telemetryState('session-a')).toBe('closed');
    });

    it('disposeForExit telemeters the transaction session and does not schedule current-session paint effects', () => {
        const owner = createEntryRestoreOwner();
        owner.attempt(baseAttempt);

        const effects = owner.disposeForExit({ currentSessionId: 'session-b' });

        expect(effectTypes(effects)).toEqual([
            'clear-entry-deadline',
            'close-entry-ownership',
            'record-restore-decision-for-session',
        ]);
        expect(effects).toContainEqual({
            mode: 'restore-anchor',
            offsetY: 120,
            reason: 'skipped',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        });
        expect(effectTypes(effects)).not.toContain('schedule-native-entry-paint-release');
        expect(effectTypes(effects)).not.toContain('native-initial-viewport-applied');
    });

    it('resetForSession clears closed-session suppression so the same session can restore again', () => {
        const owner = createEntryRestoreOwner();
        owner.attempt(baseAttempt);
        owner.observeNative({
            contentHeight: 2400,
            layoutHeight: 600,
            nowMs: 1100,
            observation: { status: 'aligned' },
            sessionId: 'session-a',
        });

        owner.resetForSession({ sessionId: 'session-a' });
        const effects = owner.attempt({
            ...baseAttempt,
            nowMs: 1200,
        });

        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    anchor: targetAnchor,
                    itemOffsetPx: 84,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-anchor',
                },
                type: 'execute-command',
            },
        ]);
    });

    it('requires exact bottom confirmation for web bottom entry restore before closing', () => {
        const owner = createEntryRestoreOwner();

        owner.beginWebBottom({
            contentHeight: 10_785,
            deadlineMs: 1500,
            layoutHeight: 779,
            nowMs: 1000,
            sessionId: 'session-a',
        });

        const nearBottom = owner.observeWebHostFacts({
            contentHeight: 10_785,
            distanceFromBottom: 63,
            layoutHeight: 779,
            nowMs: 1050,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
        });

        expect(executeEffects(nearBottom)).toEqual([
            {
                command: {
                    animated: false,
                    contentHeight: 10_785,
                    distanceFromLiveTailPx: 0,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);
        expect(effectTypes(nearBottom)).not.toContain('close-entry-ownership');
        expect(owner.telemetryState('session-a')).toBe('open');

        const exactBottom = owner.observeWebHostFacts({
            contentHeight: 10_785,
            distanceFromBottom: 0,
            layoutHeight: 779,
            nowMs: 1100,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
        });

        expect(effectTypes(exactBottom)).toEqual([
            'clear-entry-deadline',
            'close-entry-ownership',
            'record-restore-decision',
        ]);
        expect(owner.telemetryState('session-a')).toBe('closed');
    });
});

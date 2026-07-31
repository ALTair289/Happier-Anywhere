/**
 * Pin-suppression contract for the unified user-scroll-intent owner.
 *
 * The web content-growth writer resolves to the ABSOLUTE bottom, so an unauthorized fire moves
 * the reader by exactly how far they had scrolled up — the reported 100-300px snapback. Its
 * only guards against firing under the reader's hand were EVENT timestamps that expire 250ms
 * after the last input event (`resolveTranscriptAutoFollowPinWaitMs` and the command's
 * `recentUserIntent`). That is the wrong shape: a scrollbar thumb drag emits one pointerdown
 * and then nothing until release, a held key repeats slowly, and browser smooth-scroll
 * continuation outlives the last wheel event. Both guards must read the STATE-shaped fact from
 * the one intent owner, and must still let the tail be followed once the reader stops.
 */
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { createTranscriptUserScrollIntentOwner } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';
import { createTranscriptViewportController } from '@/components/sessions/transcript/viewport/createTranscriptViewportController';
import { useTranscriptBottomFollowHost } from './useTranscriptBottomFollowHost';

type BottomFollowHostDeps = Parameters<typeof useTranscriptBottomFollowHost>[0];

const originalPlatformOS = Platform.OS;

function setPlatformOS(value: typeof Platform.OS): void {
    Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

function createRef<T>(current: T): { current: T } {
    return { current };
}

const PREVIOUS_WEB_METRICS = {
    clientHeight: 600,
    element: null,
    scrollHeight: 40_000,
    scrollTop: 39_360,
} as any;

function buildDeps(userScrollIntent: ReturnType<typeof createTranscriptUserScrollIntentOwner>) {
    const controller = createTranscriptViewportController();
    const executeViewportCommand = vi.fn(() => true);
    const members = {
        applyFollowBottomIntentTakeoverApplyEffects: vi.fn(),
        applyNativeExplicitJumpConfirmationEffects: vi.fn(),
        authorizeImmediateBottomFollowWriteRef: createRef<
            BottomFollowHostDeps['authorizeImmediateBottomFollowWriteRef']['current']
        >(vi.fn(() => false)),
        canAutoFollowForReason: vi.fn(() => true),
        commitBottomFollowModeState: vi.fn(),
        commitExplicitReturnToLiveTailState: vi.fn(),
        commitScrollPinState: vi.fn(),
        currentBottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' as const }),
        executeViewportCommand,
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => true),
        hasNativeInitialViewportAppliedForCurrentSession: vi.fn(() => true),
        hasRearmedNativeBottomFollow: vi.fn(() => false),
        invalidateViewportAnchorCapture: vi.fn(),
        isPinnedRef: createRef(true),
        lastNativePinOffsetRef: createRef<number | null>(null),
        lastUserScrollIntentAtMsRef: userScrollIntent.timestampRef,
        lifecycleHost: {
            clearNativeExplicitJumpConfirmation: vi.fn(),
            getMountSettleSnapshot: vi.fn(() => ({ isMountSettleActive: false })),
            observeNativeScrollConfirmation: vi.fn(() => ({
                consumed: false,
                entrySettleEffects: [],
                explicitJumpEffects: [],
            })),
            planContentGrowthLiveTailCommand: vi.fn(() => ({
                contentGrowthLiveTailCommandEffect: {
                    reason: 'content-size-change' as const,
                    sessionId: 's1',
                    type: 'request-content-growth-live-tail-command' as const,
                },
                state: { bottomFollowState: { dragSession: null, mode: 'following' as const } },
            })),
            planFollowBottomIntentTakeover: vi.fn(() => ({
                followBottomIntentTakeoverEffects: [],
                state: { bottomFollowState: { dragSession: null, mode: 'following' as const } },
            })),
            planMeasuredNativeLiveTailPin: vi.fn(() => ({ type: 'not-ready' as const })),
            planNativeMountSettlePendingPinFlush: vi.fn(() => ({ effects: [] })),
        },
        liveTailCarveTelemetry: {
            active: false, anchorId: null, anchorKind: null, coldCount: 0, hotCount: 0,
        },
        listContentHeightRef: createRef(40_000),
        listLayoutHeightRef: createRef(600),
        listRef: createRef(null),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        nativeMountSettleAutoPinSuppressedRef: createRef(false),
        nativeMountSettleDeadlineReachedRef: createRef(false),
        nativeHotTailHeightRef: createRef(0),
        observeNativeStreamAppendOffsetEscape: vi.fn(() => false),
        pinThresholdPxRef: createRef(72),
        readCurrentNativeDistanceFromBottom: vi.fn(() => 0),
        readViewportContentMetrics: vi.fn(() => ({ contentHeight: 40_000, layoutHeight: 600 })),
        recordViewportTelemetryEvent: vi.fn(),
        requestBottomFollowScheduledWriteRef: createRef(() => {}),
        // The REAL command owner: the suppression decision must survive composition with the
        // canonical resolver, not merely look right in the input object.
        resolveViewportCommand: vi.fn((input: any) => controller.resolve(input)),
        resolveViewportTelemetryMode: vi.fn(() => 'follow-bottom'),
        resolveWebScrollMetrics: vi.fn(() => PREVIOUS_WEB_METRICS),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        tryPinToBottomDom: vi.fn(() => false),
        updateNativeInitialViewportPendingObservation: vi.fn(),
        userScrollIntent,
        wantsPinnedRef: createRef(true),
    };
    const deps = {
        ...members,
        continuousFollowOwner: 'renderer' as const,
        followBottomIntentKey: null,
        latestCommittedActivityKey: 'activity-1',
        jumpToSeq: null,
        nativeHotTailResetRequired: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: false,
        pinEnabled: true,
        pinThresholdPx: 72,
        sessionId: 's1',
        usesNativeFlashListBottomMaintenance: false,
    } as unknown as BottomFollowHostDeps;
    return { deps, executeViewportCommand };
}

async function runContentGrowth(
    userScrollIntent: ReturnType<typeof createTranscriptUserScrollIntentOwner>,
): Promise<{ tailWrites: number; unmount: () => Promise<void> }> {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { deps, executeViewportCommand } = buildDeps(userScrollIntent);
    const hook = await renderHook(
        (next: BottomFollowHostDeps) => useTranscriptBottomFollowHost(next),
        { initialProps: deps },
    );
    executeViewportCommand.mockClear();
    hook.getCurrent().requestAutomaticLiveTailPin(PREVIOUS_WEB_METRICS, 'content-size-change');
    animationFrames.splice(0).forEach((callback) => callback(16));
    const tailWrites = executeViewportCommand.mock.calls.filter(
        (call) => (call as unknown[])[0] != null
            && ((call as unknown[])[0] as { kind?: string }).kind === 'preserve-live-tail-distance',
    ).length;
    return { tailWrites, unmount: () => hook.unmount() };
}

describe('web content-growth live-tail pin suppression', () => {
    afterEach(() => {
        setPlatformOS(originalPlatformOS);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('does not re-pin the live tail while a scrollbar drag is still open', async () => {
        setPlatformOS('web');
        const nowMs = 100_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const userScrollIntent = createTranscriptUserScrollIntentOwner();
        // Press on the scrollbar band 5s ago; the thumb is still held. No further events.
        userScrollIntent.setGestureActive({ active: true, atMs: nowMs - 5_000, gesture: 'drag' });

        const { tailWrites, unmount } = await runContentGrowth(userScrollIntent);

        expect(tailWrites).toBe(0);
        await unmount();
    });

    it('does not re-pin the live tail during smooth-scroll continuation of a wheel gesture', async () => {
        setPlatformOS('web');
        const nowMs = 100_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const userScrollIntent = createTranscriptUserScrollIntentOwner();
        // Last wheel event 300ms ago: past the 250ms event window, still inside the physical
        // gesture (Chromium keeps animating the scroll for hundreds of ms).
        userScrollIntent.recordInput({ atMs: nowMs - 300 });

        const { tailWrites, unmount } = await runContentGrowth(userScrollIntent);

        expect(tailWrites).toBe(0);
        await unmount();
    });

    it('still re-pins the live tail once the reader has genuinely stopped', async () => {
        setPlatformOS('web');
        const nowMs = 100_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const userScrollIntent = createTranscriptUserScrollIntentOwner();
        userScrollIntent.recordInput({ atMs: nowMs - 5_000 });
        // Stopped INSIDE the pin band: they are at the live tail, so following it is what they
        // asked for. This is the paired negative that keeps the parked guard from being a blanket
        // suppression.
        userScrollIntent.observeDistanceFromLiveTail({
            atMs: nowMs - 5_000,
            distanceFromLiveTailPx: 40,
            pinThresholdPx: 72,
        });

        const { tailWrites, unmount } = await runContentGrowth(userScrollIntent);

        expect(tailWrites).toBe(1);
        await unmount();
    });

    /**
     * THE REPORTED SYMPTOM. "I scroll, the scroll ENDS, and then it moves back."
     *
     * Every input-recency predicate in this corridor — `isLive`'s 320ms continuation window, the
     * 250ms auto-pin delay, `recentUserIntent` — is FALSE five seconds after the last wheel event.
     * So the guard that has to hold here cannot be an event window; no constant is long enough for
     * a reader who is READING. The automatic writer resolves to the ABSOLUTE bottom and its
     * decision basis (`previousDistanceFromLiveTailPx`) is captured BEFORE the growth it responds
     * to, so a basis taken while the reader was still at the tail authorizes yanking them back by
     * exactly how far they had scrolled up.
     */
    it('does not re-pin the live tail seconds after the reader parked away from it', async () => {
        setPlatformOS('web');
        const nowMs = 100_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const userScrollIntent = createTranscriptUserScrollIntentOwner();
        // The reader wheels up; the frame they land on measures 300px from the live tail.
        userScrollIntent.recordInput({ atMs: nowMs - 5_000, direction: -1 });
        userScrollIntent.observeDistanceFromLiveTail({
            atMs: nowMs - 5_000,
            distanceFromLiveTailPx: 300,
            pinThresholdPx: 72,
        });
        // Then they STOP and read for five seconds. No further input of any kind.
        expect(userScrollIntent.isLive(nowMs)).toBe(false);

        // Content height changes. `PREVIOUS_WEB_METRICS` is the pre-growth basis: 40px from the
        // tail, i.e. it still claims the reader was following.
        const { tailWrites, unmount } = await runContentGrowth(userScrollIntent);

        expect(tailWrites).toBe(0);
        await unmount();
    });
});

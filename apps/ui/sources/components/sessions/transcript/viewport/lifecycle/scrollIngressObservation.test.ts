import { describe, expect, it, vi } from 'vitest';

import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { createTranscriptLifecycleHost } from './lifecycleHost';
import {
    observeTranscriptScrollIngress,
    type TranscriptScrollIngressCallbacks,
    type TranscriptScrollIngressInput,
} from './scrollIngressObservation';

function webMetrics(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>): WebTranscriptScrollMetrics {
    return {
        clientHeight: params.clientHeight,
        element: {} as HTMLElement,
        scrollHeight: params.scrollHeight,
        scrollTop: params.scrollTop,
    };
}

function webScrollIngressInput(
    overrides: Partial<TranscriptScrollIngressInput> = {},
): TranscriptScrollIngressInput {
    return {
        bottomFollowModeState: {
            dragSession: null,
            mode: 'released',
        },
        configuredBottomDistanceNoiseFloorPx: 0,
        eventNativeEvent: {
            contentOffset: { y: 0 },
            contentSize: { height: 0 },
            isTrusted: true,
            layoutMeasurement: { height: 0 },
        },
        hasNativeContentMeasurement: false,
        hasNativeInitialViewportApplied: false,
        hasRenderedItems: true,
        isLoaded: true,
        isWarmKeepAliveInstance: false,
        lastNativePinOffset: null,
        lastScrollOffsetForIntent: 20,
        lastUserScrollIntentAtMs: 0,
        loadOlderInFlight: false,
        measuredContentHeight: 1200,
        measuredLayoutHeight: 400,
        nativeListDragActive: false,
        nativeMomentumScrollActive: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: true,
        nowMs: 1300,
        pendingBottomPin: false,
        pinEnabled: true,
        pinThresholdPx: 72,
        platform: 'web',
        sessionEntry: {
            sessionId: 'session-a',
            shouldFollowBottom: false,
        },
        sessionId: 'session-a',
        userIntentRecentMs: 500,
        usesNativeFlashListBottomMaintenance: false,
        wantsPinned: false,
        ...overrides,
    };
}

function scrollIngressCallbacks(
    overrides: Partial<TranscriptScrollIngressCallbacks> = {},
): TranscriptScrollIngressCallbacks {
    const lifecycleHost = createTranscriptLifecycleHost();
    lifecycleHost.enterSession({
        platform: 'web',
        sessionId: 'session-a',
        shouldFollowLiveTail: false,
    });

    return {
        activeViewportCommandOwner: () => 'follow',
        applyEntryRestoreOwnerEffects: () => {},
        applyNativeMountSettlePassiveDriftRepinObservation: () => {},
        applyNativePrependOwnerEffects: () => {},
        applyScrollObservationPlan(plan, callbacks) {
            callbacks.continueAfterEarlyEffects({
                hasNativeMountSettlePassiveDriftRepinObservation: false,
                recentUserIntent: plan.recentUserIntent,
            });
            return plan.disposition === 'consumed';
        },
        commitOpenNativeEntryRestoreVisibleState: () => {},
        drainDeferredNewerMessages: () => {},
        hasOpenNativeEntryRestoreTransaction: () => false,
        hasOpenNativePrependTransaction: () => false,
        invalidateViewportAnchorCapture: () => {},
        lifecycleHost,
        observeMountSettleMetrics: () => {},
        observeNativeConfirmation: () => false,
        observeNativeEntryRestoreHostFacts: () => [],
        observeNativeBlankRecovery: () => {},
        observeNativePrependOwner: () => {},
        observeOlderPaginationScroll: () => {},
        observeWebGenuineScrollMovement: () => ({
            webMovedSinceLastObservation: true,
            webObservedUpwardIntent: true,
            webObservedUserScrollMovement: true,
        }),
        observeWebTranscriptNavigationVisibility: () => {},
        preemptEntryRestoreTransaction: () => {},
        promotePendingJumpSeqViewportSnapshot: () => false,
        recordNativeScrollObservation: () => {},
        recordNativeVisibleWindowTelemetry: () => {},
        recordWebRouteJumpProtectionClearingMovement: () => {},
        refreshInFlightWebPrependAnchor: () => {},
        resolveWebScrollMetrics: () => null,
        retargetPendingWebPrependAnchorForUserScroll: () => {},
        shouldIgnoreNativeInvalidScrollObservation: () => false,
        trustedNativePrependScroll: () => [],
        updateNativeViewportPaintObserved: () => {},
        verifyWebEntryRestoreTransaction: () => {},
        ...overrides,
    };
}

describe('observeTranscriptScrollIngress', () => {
    it('still observes exact-top pagination when jump promotion consumes generic viewport publication', () => {
        const observeOlderPaginationScroll = vi.fn();
        const applyScrollObservationPlan = vi.fn(() => false);
        const observeWebGenuineScrollMovement = vi.fn(() => ({
            webMovedSinceLastObservation: true,
            webObservedUpwardIntent: true,
            webObservedUserScrollMovement: true,
        }));

        observeTranscriptScrollIngress(webScrollIngressInput(), scrollIngressCallbacks({
            applyScrollObservationPlan,
            observeOlderPaginationScroll,
            observeWebGenuineScrollMovement,
            promotePendingJumpSeqViewportSnapshot: () => true,
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 500,
                scrollHeight: 2000,
                scrollTop: 0,
            }),
        }));

        expect(observeOlderPaginationScroll).toHaveBeenCalledOnce();
        expect(observeOlderPaginationScroll).toHaveBeenCalledWith({
            contentHeight: 1200,
            distanceFromBottom: 1500,
            layoutHeight: 400,
            offsetY: 0,
            trigger: 'edge-reached',
            webMetrics: expect.objectContaining({
                clientHeight: 500,
                scrollHeight: 2000,
                scrollTop: 0,
            }),
        });
        expect(observeWebGenuineScrollMovement).not.toHaveBeenCalled();
        expect(applyScrollObservationPlan).not.toHaveBeenCalled();
    });

    it('consumes the renderer movement fact without independently reclassifying the same Legend event', () => {
        const lifecycleHost = createTranscriptLifecycleHost();
        lifecycleHost.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });
        const observeWebGenuineScrollMovement = vi.fn();
        const preemptEntryRestoreTransaction = vi.fn();
        const recordWebRouteJumpProtectionClearingMovement = vi.fn();
        const verifyWebEntryRestoreTransaction = vi.fn();

        observeTranscriptScrollIngress(webScrollIngressInput({
            continuousFollowOwner: 'renderer',
            lastScrollOffsetForIntent: 400,
            webMovementFact: {
                atEndPublicationCause: 'layout',
                direction: 1,
                downwardIntent: false,
                isGenuineUserMovement: false,
                movedSinceLastObservation: true,
                upwardIntent: false,
            },
        }), scrollIngressCallbacks({
            lifecycleHost,
            observeWebGenuineScrollMovement,
            preemptEntryRestoreTransaction,
            recordWebRouteJumpProtectionClearingMovement,
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 800,
            }),
            verifyWebEntryRestoreTransaction,
        }));

        expect(observeWebGenuineScrollMovement).not.toHaveBeenCalled();
        expect(preemptEntryRestoreTransaction).not.toHaveBeenCalled();
        expect(recordWebRouteJumpProtectionClearingMovement).not.toHaveBeenCalled();
        expect(verifyWebEntryRestoreTransaction).toHaveBeenCalledOnce();
        expect(lifecycleHost.getState().bottomFollowState.mode).toBe('released');
    });

    it('tells navigation visibility whether the reader genuinely moved before it publishes', () => {
        const genuineUserMovementByCall: boolean[] = [];
        const observeWebTranscriptNavigationVisibility = (input: Readonly<{ genuineUserMovement: boolean }>) => {
            genuineUserMovementByCall.push(input.genuineUserMovement);
        };

        // A programmatic landing write: Legend classifies its own echo as NOT
        // genuine, so the jump's landed anchor must survive the frame.
        observeTranscriptScrollIngress(webScrollIngressInput({
            webMovementFact: {
                atEndPublicationCause: 'command',
                direction: 1,
                downwardIntent: true,
                isGenuineUserMovement: false,
                movedSinceLastObservation: true,
                upwardIntent: false,
            },
        }), scrollIngressCallbacks({ observeWebTranscriptNavigationVisibility }));

        expect(genuineUserMovementByCall).toEqual([false]);

        observeTranscriptScrollIngress(webScrollIngressInput({
            webMovementFact: {
                atEndPublicationCause: 'layout',
                direction: -1,
                downwardIntent: false,
                isGenuineUserMovement: true,
                movedSinceLastObservation: true,
                upwardIntent: true,
            },
        }), scrollIngressCallbacks({ observeWebTranscriptNavigationVisibility }));

        expect(genuineUserMovementByCall).toEqual([false, true]);
    });

    it('classifies native user authority from the drag fact, the only user signal a native scroll frame carries', () => {
        const genuineUserMovementByCall: boolean[] = [];
        const observeWebTranscriptNavigationVisibility = (input: Readonly<{ genuineUserMovement: boolean }>) => {
            genuineUserMovementByCall.push(input.genuineUserMovement);
        };
        // RN puts `isTrusted` on the SYNTHETIC event wrapper, never on the
        // native scroll payload this ingress receives, so a native frame must
        // never be classified from it.
        const nativeScrollEvent = {
            contentOffset: { y: 400 },
            contentSize: { height: 2_000 },
            layoutMeasurement: { height: 500 },
        } as const;

        // The landing's own programmatic write: no drag is open, so the jump's
        // landed anchor must survive the frame.
        observeTranscriptScrollIngress(webScrollIngressInput({
            eventNativeEvent: nativeScrollEvent,
            platform: 'native',
        }), scrollIngressCallbacks({ observeWebTranscriptNavigationVisibility }));

        expect(genuineUserMovementByCall).toEqual([false]);

        // The reader drags the list away: `onScrollBeginDrag` opened a native
        // drag before this frame, which releases the landing immediately.
        observeTranscriptScrollIngress(webScrollIngressInput({
            eventNativeEvent: nativeScrollEvent,
            nativeListDragActive: true,
            platform: 'native',
        }), scrollIngressCallbacks({ observeWebTranscriptNavigationVisibility }));

        expect(genuineUserMovementByCall).toEqual([false, true]);
    });

    it('publishes the release for a renderer whose movement fact only arrives after the promotion gate', () => {
        const genuineUserMovementByCall: boolean[] = [];

        observeTranscriptScrollIngress(webScrollIngressInput(), scrollIngressCallbacks({
            observeWebTranscriptNavigationVisibility: (input) => {
                genuineUserMovementByCall.push(input.genuineUserMovement);
            },
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 300,
            }),
        }));

        expect(genuineUserMovementByCall).toEqual([false, true]);
    });

    it('routes invalid native offsets to blank recovery outside telemetry recording', () => {
        const log: string[] = [];

        observeTranscriptScrollIngress(webScrollIngressInput({
            eventNativeEvent: {
                contentOffset: { y: -995_030 },
                contentSize: { height: 2_000 },
                layoutMeasurement: { height: 500 },
            },
            platform: 'native',
        }), scrollIngressCallbacks({
            observeNativeBlankRecovery(reason, input) {
                log.push(`blank:${reason}:${input.rawOffsetY}`);
            },
            recordNativeScrollObservation(input) {
                log.push(`scroll:${input.reason}:${input.rawOffsetY}`);
            },
            recordNativeVisibleWindowTelemetry(reason) {
                log.push(`telemetry:${reason}`);
            },
            shouldIgnoreNativeInvalidScrollObservation: () => true,
        }));

        expect(log).toEqual([
            'scroll:invalid-native-offset:-995030',
            'blank:invalid-native-offset:-995030',
            'telemetry:invalid-native-offset',
        ]);
    });

    it('refreshes the web prepend anchor when older pagination starts during a discrete scroll observation', () => {
        const log: string[] = [];
        let loadOlderInFlight = false;

        observeTranscriptScrollIngress(webScrollIngressInput(), scrollIngressCallbacks({
            observeOlderPaginationScroll(input) {
                log.push(`older:${input.trigger}`);
                loadOlderInFlight = true;
                return loadOlderInFlight;
            },
            refreshInFlightWebPrependAnchor(input) {
                log.push(`refresh:${input.userScrolledDuringLoad}`);
            },
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 500,
                scrollHeight: 2000,
                scrollTop: 0,
            }),
        }));

        expect(log).toEqual([
            'older:edge-reached',
            'refresh:true',
        ]);
    });

    it.each([
        { continuousFollowOwner: 'app' as const, expectedMode: 'following' as const },
        { continuousFollowOwner: 'renderer' as const, expectedMode: 'released' as const },
    ])('threads $continuousFollowOwner follow ownership into raw trusted web arrival compatibility', ({
        continuousFollowOwner,
        expectedMode,
    }) => {
        const lifecycleHost = createTranscriptLifecycleHost();
        lifecycleHost.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        observeTranscriptScrollIngress(webScrollIngressInput({
            continuousFollowOwner,
            lastScrollOffsetForIntent: 400,
        }), scrollIngressCallbacks({
            lifecycleHost,
            observeWebGenuineScrollMovement: () => ({
                webMovedSinceLastObservation: true,
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: false,
            }),
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 800,
            }),
        }));

        expect(lifecycleHost.getState().bottomFollowState.mode).toBe(expectedMode);
    });
});

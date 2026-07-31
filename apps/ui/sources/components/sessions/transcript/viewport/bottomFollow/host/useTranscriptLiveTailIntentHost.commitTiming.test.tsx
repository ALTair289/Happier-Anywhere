import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { resolveJumpToBottomAffordanceState } from '@/components/sessions/transcript/scroll/jumpToBottomAffordanceState';
import { createTranscriptUserScrollIntentOwner } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';
import { useTranscriptLiveTailIntentHost } from './useTranscriptLiveTailIntentHost';

type Host = ReturnType<typeof useTranscriptLiveTailIntentHost>;
type HostDeps = Parameters<typeof useTranscriptLiveTailIntentHost>[0];

const neverSettles = new Promise<never>(() => {});

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createDeps(
    sessionId: string,
    continuousFollowOwner: 'app' | 'renderer',
    emitViewportChange: ReturnType<typeof vi.fn>,
): HostDeps {
    return {
        commitBottomFollowModeState: vi.fn(),
        commitJumpToBottomDistanceForVisibilityRef: createRef(vi.fn()),
        commitScrollPinEvent: vi.fn(),
        commitScrollPinState: vi.fn(),
        continuousFollowOwner,
        emitViewportChange,
        isPinnedRef: createRef(true),
        lastPinOffsetForIntentRef: createRef(0),
        userScrollIntent: createTranscriptUserScrollIntentOwner(),
        lifecycleHost: {
            planExplicitReturnToLiveTail: vi.fn(),
        },
        scrollPinRef: createRef({ isPinned: true, newActivityCount: 0 }),
        sessionId,
        transcriptScrollPinEnabled: true,
        wantsPinnedRef: createRef(true),
    } as unknown as HostDeps;
}

function Harness(props: Readonly<{
    apiRef: { current: Host | null };
    deps: HostDeps;
    shouldSuspend?: boolean;
}>) {
    const host = useTranscriptLiveTailIntentHost(props.deps);
    React.useLayoutEffect(() => {
        props.apiRef.current = host;
    }, [host, props.apiRef]);
    if (props.shouldSuspend === true) throw neverSettles;
    return null;
}

function renderHarness(props: React.ComponentProps<typeof Harness>): React.ReactElement {
    return (
        <React.Suspense fallback={null}>
            <Harness {...props} />
        </React.Suspense>
    );
}

describe('useTranscriptLiveTailIntentHost commit timing', () => {
    it('keeps the return affordance visible across repeated far-target command landings', async () => {
        const sessionId = 'session-repeat-jump';
        let distanceFromBottom = 0;
        let scrollPin = {
            isPinned: true,
            lastActivityKey: null,
            newActivityCount: 0,
        };
        const baseDeps = createDeps(sessionId, 'renderer', vi.fn(() => true));
        const scrollPinRef = baseDeps.scrollPinRef;
        baseDeps.commitJumpToBottomDistanceForVisibilityRef.current = vi.fn((nextDistance: number) => {
            distanceFromBottom = nextDistance;
        });
        const commitScrollPinState = vi.fn((nextState) => {
            scrollPin = nextState;
            scrollPinRef.current = nextState;
        });
        const commitScrollPinEvent = vi.fn((event) => {
            if (event.type !== 'rendererAtEnd') return;
            scrollPin = {
                ...scrollPin,
                isPinned: event.enabled && event.isAtEnd,
            };
            scrollPinRef.current = scrollPin;
        });
        const planExplicitReturnToLiveTail: HostDeps['lifecycleHost']['planExplicitReturnToLiveTail'] = vi.fn(() => ({
            explicitReturnEffects: [
                {
                    sessionId,
                    type: 'apply-explicit-return-clear-user-scroll-intent',
                },
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId,
                    type: 'apply-explicit-return-to-live-tail-viewport',
                },
            ],
            lifecycleEffects: [],
            state: {
                automaticPinAuthority: true,
                bottomFollowState: {
                    dragSession: null,
                    mode: 'following',
                },
                fingerDown: false,
                followMode: 'following',
                gesturePhase: 'settled',
                sessionId,
            },
            viewportEffects: [],
        } as const));
        const deps = {
            ...baseDeps,
            commitScrollPinEvent,
            commitScrollPinState,
            lifecycleHost: {
                planExplicitReturnToLiveTail,
            },
        } satisfies HostDeps;
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        const commitFarTargetPromotion = (nextDistance: number) => {
            // This is the jump host's committed semantic promotion. A subsequent renderer
            // callback must not reinterpret the end of its local window as the global tail.
            deps.isPinnedRef.current = false;
            deps.wantsPinnedRef.current = false;
            scrollPin = {
                ...scrollPin,
                isPinned: false,
            };
            deps.scrollPinRef.current = scrollPin;
            distanceFromBottom = nextDistance;
        };
        const readAffordance = (hasMoreNewerBeyondRenderedWindow: boolean) =>
            resolveJumpToBottomAffordanceState({
                distanceFromBottom,
                enabled: true,
                hasMoreNewerBeyondRenderedWindow,
                isPinned: scrollPin.isPinned,
                minNewActivityCount: 1,
                newActivityCount: 0,
                revealThresholdPx: 1_000,
            });
        const rendererFollowingAtLocalWindowEnd = {
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        } as const;

        await act(async () => {
            tree = renderer.create(renderHarness({ apiRef, deps }));
        });

        commitFarTargetPromotion(50_281);
        apiRef.current!.handleRendererAtEndChange(
            rendererFollowingAtLocalWindowEnd,
            { cause: 'command' },
        );
        // The first landing is protected by target-window mode, which masks a stale pin.
        expect(readAffordance(true).isVisible).toBe(true);

        apiRef.current!.commitExplicitReturnToLiveTailState('jump-to-bottom');
        distanceFromBottom = 0;
        expect(deps.isPinnedRef.current).toBe(true);
        expect(scrollPin.isPinned).toBe(true);
        expect(readAffordance(false).isVisible).toBe(false);

        commitFarTargetPromotion(101_709);
        expect(deps.isPinnedRef.current).toBe(false);
        expect(scrollPin.isPinned).toBe(false);
        apiRef.current!.handleRendererAtEndChange(
            rendererFollowingAtLocalWindowEnd,
            { cause: 'command' },
        );

        // The repeat landing has no target-window override. The committed far distance and
        // released pin must survive the renderer's command-attributed physical-end callback.
        expect(distanceFromBottom).toBe(101_709);
        expect(deps.isPinnedRef.current).toBe(false);
        expect(scrollPin.isPinned).toBe(false);
        expect(readAffordance(false).isVisible).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });

    it('keeps renderer A deps authoritative through an abandoned app-owned B render', async () => {
        const emitA = vi.fn(() => true);
        const emitB = vi.fn(() => true);
        const depsA = createDeps('session-a', 'renderer', emitA);
        const depsB = createDeps('session-b', 'app', emitB);
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({ apiRef, deps: depsA }), {
                unstable_isConcurrent: true,
            } as unknown as renderer.TestRendererOptions);
        });
        const committedHost = apiRef.current!;

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness({
                    apiRef,
                    deps: depsB,
                    shouldSuspend: true,
                }));
            });
            await Promise.resolve();
        });

        committedHost.handleRendererAtEndChange({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        }, { cause: 'user' });
        expect(emitA).toHaveBeenCalledTimes(1);
        expect(emitB).not.toHaveBeenCalled();

        await act(async () => {
            tree.update(renderHarness({ apiRef, deps: depsB }));
        });
        apiRef.current!.handleRendererAtEndChange({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        }, { cause: 'user' });
        expect(emitA).toHaveBeenCalledTimes(1);
        expect(emitB).not.toHaveBeenCalled();

        await act(async () => {
            tree.unmount();
        });
    });
});

describe('useTranscriptLiveTailIntentHost live-tail parking release', () => {
    it('releases the reader parked position on an explicit return to the live tail', async () => {
        // O1: the parked position is durable STATE with no timer — while it holds, every
        // automatic bottom-follow write is refused at `applyAuthorizedBottomFollowWrite`. The
        // deliberate return (jump-to-bottom / follow-bottom intent) is the reader's consent to
        // be followed again, so it MUST clear it here. If it does not, a reader who scrolled up
        // and then pressed jump-to-bottom lands at the tail and is never followed again for the
        // life of the mount.
        const sessionId = 'session-parked-jump';
        const deps = createDeps(sessionId, 'renderer', vi.fn(() => true));
        (deps.lifecycleHost.planExplicitReturnToLiveTail as ReturnType<typeof vi.fn>)
            .mockImplementation(() => ({
                explicitReturnEffects: [
                    { sessionId, type: 'apply-explicit-return-clear-user-scroll-intent' },
                    {
                        distanceFromLiveTailPx: 0,
                        isPinned: true,
                        sessionId,
                        type: 'apply-explicit-return-to-live-tail-viewport',
                    },
                ],
                lifecycleEffects: [],
                state: {
                    automaticPinAuthority: true,
                    bottomFollowState: { dragSession: null, mode: 'following' },
                    fingerDown: false,
                    followMode: 'following',
                    gesturePhase: 'settled',
                    sessionId,
                },
                viewportEffects: [],
            }));
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({ apiRef, deps }));
        });

        // The reader wheels up and the landing frame measures them 900px from the tail.
        deps.userScrollIntent.recordInput({ atMs: Date.now(), direction: -1 });
        deps.userScrollIntent.observeDistanceFromLiveTail({
            atMs: Date.now(),
            distanceFromLiveTailPx: 900,
            pinThresholdPx: 72,
        });
        expect(deps.userScrollIntent.isParkedAwayFromLiveTail()).toBe(true);

        apiRef.current!.commitExplicitReturnToLiveTailState('jump-to-bottom');

        expect(deps.userScrollIntent.isParkedAwayFromLiveTail()).toBe(false);
        expect(deps.userScrollIntent.parkedDistanceFromLiveTailPx()).toBeNull();

        await act(async () => {
            tree.unmount();
        });
    });
});

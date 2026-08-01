import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { createTranscriptFreshnessGate, resolveTranscriptUtteranceIdentity } from './transcriptFreshnessGate';

import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';

function utteranceId(localId: string): string {
    const identity = resolveTranscriptUtteranceIdentity(localId);
    if (identity == null) throw new Error(`expected an utterance identity for ${localId}`);
    return identity;
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const motionState = vi.hoisted(() => ({
    startedTimings: [] as any[],
    animatedValues: [] as Array<{ __value: number }>,
}));

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            Animated: {
                Value: function Value(this: any, initial: number) {
                    this.__value = initial;
                    this.setValue = (next: number) => {
                        this.__value = next;
                    };
                    motionState.animatedValues.push(this);
                },
                timing: (_value: any, config: any) => ({
                    start: () => {
                        motionState.startedTimings.push(config);
                    },
                }),
                parallel: () => ({ start: () => undefined }),
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

function createRuntime(gate: ReturnType<typeof createTranscriptFreshnessGate>) {
    return {
        gate,
        config: {
            preset: 'full' as const,
            freshnessMs: 60_000,
            animateNewItemsEnabled: true,
            animateToolExpandCollapseEnabled: true,
            animateToolExpandCollapseFreshOnly: true,
            animateThinkingEnabled: true,
        },
    };
}

describe('TranscriptEnterWrapper — the send crossover', () => {
    beforeEach(() => {
        motionState.startedTimings = [];
        motionState.animatedValues = [];
    });

    /**
     * The 500 ms void, root cause. The reveal used to be gated on `onLayout` AND a following
     * `requestAnimationFrame` — two JS-thread events. The 2026-08-01 native capture measured a
     * 1.0–3.6 s JS stall spanning every send, so both waits were unbounded and the row stayed at
     * `opacity: 0` for as long as the stall. A reveal must never outlive its own animation.
     */
    it('starts the enter animation without waiting for a layout event or an animation frame', async () => {
        const raf = globalThis.requestAnimationFrame;
        // A stalled JS thread: scheduled frames never run.
        (globalThis as any).requestAnimationFrame = () => 1;
        try {
            const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
            const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
            const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });

            await act(async () => {
                renderer.create(
                    <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                        <TranscriptEnterWrapper id="msg:server-1" createdAt={990}>
                            <div />
                        </TranscriptEnterWrapper>
                    </TranscriptMotionContext.Provider>,
                );
            });

            expect(motionState.startedTimings.length).toBeGreaterThan(0);
            expect(motionState.startedTimings[0]?.toValue).toBe(1);
        } finally {
            (globalThis as any).requestAnimationFrame = raf;
        }
    });

    /**
     * Identity continuity across the handover: the committed row carries content the reader has
     * already been shown by the pending row, so it is a continuation, not an entrance. Fading it in
     * from 0 is an animation that masks a remount.
     */
    it('does not animate a committed row that repaints an utterance the pending row already painted', async () => {
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
        const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });
        const utterance = utteranceId('local-1');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                    <TranscriptEnterWrapper id="pending-queue" createdAt={990} paintedIds={[utterance]}>
                        <div />
                    </TranscriptEnterWrapper>
                </TranscriptMotionContext.Provider>,
            );
        });

        const pendingTimings = motionState.startedTimings.length;
        const pendingAnimatedValues = motionState.animatedValues.length;
        expect(pendingTimings).toBeGreaterThan(0);

        // The crossover, as Legend performs it: the pending row's subtree is torn down and the
        // committed row mounts as a NEW subtree under a different item key.
        await act(async () => {
            tree!.unmount();
        });
        await act(async () => {
            renderer.create(
                <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                    <TranscriptEnterWrapper id="msg:server-1" createdAt={990} paintedIds={[utterance]}>
                        <div />
                    </TranscriptEnterWrapper>
                </TranscriptMotionContext.Provider>,
            );
        });

        expect(motionState.startedTimings.length).toBe(pendingTimings);
        expect(motionState.animatedValues.length).toBe(pendingAnimatedValues);
    });

    it('still animates a row whose painted identity was never shown', async () => {
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
        const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });

        await act(async () => {
            renderer.create(
                <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                    <TranscriptEnterWrapper
                        id="msg:server-2"
                        createdAt={990}
                        paintedIds={[utteranceId('local-2')]}
                    >
                        <div />
                    </TranscriptEnterWrapper>
                </TranscriptMotionContext.Provider>,
            );
        });

        expect(motionState.startedTimings.length).toBeGreaterThan(0);
    });
});

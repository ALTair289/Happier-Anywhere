import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';

import {
    useTranscriptFirstPaintState,
    type TranscriptFirstPaintStateDeps,
} from './useTranscriptItemsPipeline';

function createDeps(
    overrides: Partial<TranscriptFirstPaintStateDeps> = {},
): TranscriptFirstPaintStateDeps {
    return {
        applySessionOpenLatchEffectsRef: { current: vi.fn() },
        currentSessionIdRef: { current: 'session-a' },
        entryAnchorForRender: {
            capturedAtMs: 1,
            itemId: 'row-42',
            itemOffsetPx: 40,
            kind: 'message',
            messageId: 'row-42',
        },
        entryRestoreOwner: {
            hasOpenTransaction: () => true,
        } as unknown as EntryRestoreOwner,
        firstListPaintObserved: true,
        isLoaded: true,
        isWarmKeepAliveInstance: false,
        itemCount: 10,
        jumpToSeqActive: false,
        lastPinOffsetForIntentRef: { current: 320 },
        nativeEntryRestorePaintReleased: true,
        nativeFirstPaintFallbackReleaseTimeoutRef: { current: null },
        nativeInitialViewportPendingObservation: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: false,
        nativeViewportPaintObserved: false,
        nativeViewportPaintObservedRef: { current: false },
        pinThresholdPx: 72,
        platformOS: 'ios',
        rendererKind: 'legendList',
        routeHydrationPending: false,
        sessionId: 'session-a',
        sessionOpenLatch: {
            onNativeFirstPaintFallbackDeadline: () => ({ effects: [] }),
            shouldShowNativeFirstPaintPlaceholder: () => false,
        } as unknown as SessionOpenLatch,
        transcriptInitialFillBudgetMs: 2_000,
        transcriptMountSettleQuiescentWindowMs: 120,
        usesNativeFlashListBottomMaintenance: false,
        ...overrides,
    };
}

describe('bounded first-paint presentation', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('reveals a web transcript whose first list paint never arrives once the bounded deadline elapses', async () => {
        vi.useFakeTimers();
        const stalledDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: stalledDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(
                stalledDeps.transcriptInitialFillBudgetMs
                + stalledDeps.transcriptMountSettleQuiescentWindowMs * 2
                + 1,
            );
        });

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('reveals a stalled native keyed placement once the bounded deadline elapses', async () => {
        vi.useFakeTimers();
        const stalledDeps = createDeps();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: stalledDeps },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'native',
                type: 'started',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(
                stalledDeps.transcriptInitialFillBudgetMs
                + stalledDeps.transcriptMountSettleQuiescentWindowMs * 2
                + 1,
            );
        });

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('bounds a later cover after an earlier one cleared on its own', async () => {
        vi.useFakeTimers();
        const coveredDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const deadlineMs =
            coveredDeps.transcriptInitialFillBudgetMs
            + coveredDeps.transcriptMountSettleQuiescentWindowMs * 2
            + 1;
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: coveredDeps },
        );

        // The first cover clears on its own well inside the bound.
        await hook.rerender({ ...coveredDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(deadlineMs);
        });

        // A later legitimate cover (warm re-entry restoring a detached position) must still be
        // bounded rather than either lingering or being revealed instantly by a spent deadline.
        await hook.rerender({ ...coveredDeps, firstListPaintObserved: false });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(deadlineMs);
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('never covers already painted rows while the session route re-hydrates', async () => {
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: createDeps({
                    entryAnchorForRender: null,
                    firstListPaintObserved: true,
                    isLoaded: true,
                    itemCount: 10,
                    platformOS: 'web',
                    rendererKind: 'legendList',
                    routeHydrationPending: true,
                }),
            },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        expect(hook.getCurrent().showRouteHydrationFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('treats a loaded empty transcript as terminal even when a persisted entry anchor exists', async () => {
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: createDeps({
                    firstListPaintObserved: false,
                    isLoaded: true,
                    itemCount: 0,
                    platformOS: 'web',
                    rendererKind: 'legendList',
                }),
            },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });
});

describe('web Legend renderer-ready first-paint presentation', () => {
    it('covers loaded bottom content until Legend reports its first onLoad readiness fact', async () => {
        const pendingDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: pendingDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await hook.rerender({
            ...pendingDeps,
            firstListPaintObserved: true,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('does not add the Legend readiness join to the web Flash fallback', async () => {
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: createDeps({
                    entryAnchorForRender: null,
                    firstListPaintObserved: false,
                    platformOS: 'web',
                    rendererKind: 'flashList',
                }),
            },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        await hook.unmount();
    });

    it('covers a still-loading web Legend transcript before rows exist, then releases a loaded empty transcript', async () => {
        const loadingDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: false,
            itemCount: 0,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: loadingDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);
        await hook.rerender({
            ...loadingDeps,
            isLoaded: false,
            itemCount: 10,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);
        await hook.rerender({
            ...loadingDeps,
            isLoaded: true,
            itemCount: 0,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('keeps a detached keyed entry covered until its existing owner and renderer join completes', async () => {
        const pendingDeps = createDeps({
            firstListPaintObserved: false,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: pendingDeps },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'web',
                type: 'started',
            });
        });
        await hook.rerender({
            ...pendingDeps,
            firstListPaintObserved: true,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                outcome: 'settled',
                platform: 'web',
                type: 'finished',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'confirmed',
                sessionId: 'session-a',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });
});

describe('native keyed entry first-paint presentation', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('stays covered after the legacy paint release until owner confirmation and renderer settle both arrive', async () => {
        vi.useFakeTimers();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: createDeps() },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'native',
                type: 'started',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'confirmed',
                sessionId: 'session-a',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                outcome: 'settled',
                platform: 'native',
                type: 'finished',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('joins the current renderer placement when the projection row alias changed', async () => {
        vi.useFakeTimers();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: createDeps({
                    entryAnchorForRender: {
                        capturedAtMs: 1,
                        itemId: 'persisted-row-alias',
                        itemOffsetPx: 40,
                        kind: 'message',
                        messageId: 'message-42',
                    },
                }),
            },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'current-row-alias',
                platform: 'native',
                type: 'started',
            });
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'confirmed',
                sessionId: 'session-a',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'current-row-alias',
                outcome: 'settled',
                platform: 'native',
                type: 'finished',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('ignores stale platform and session completion identities', async () => {
        vi.useFakeTimers();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: createDeps() },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'native',
                type: 'started',
            });
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'confirmed',
                sessionId: 'session-a',
            });
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                outcome: 'settled',
                platform: 'web',
                type: 'finished',
            });
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-b',
                itemId: 'row-42',
                outcome: 'settled',
                platform: 'native',
                type: 'finished',
            });
        });

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);
        await hook.unmount();
    });

    it('waits for the app owner after user takeover preempts renderer placement', async () => {
        vi.useFakeTimers();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: createDeps({
                    nativeEntryRestorePaintReleased: false,
                    sessionOpenLatch: {
                        onNativeFirstPaintFallbackDeadline: () => ({ effects: [] }),
                        shouldShowNativeFirstPaintPlaceholder: () => true,
                    } as unknown as SessionOpenLatch,
                }),
            },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'native',
                type: 'started',
            });
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                outcome: 'preempted',
                platform: 'native',
                type: 'finished',
            });
        });

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);
        act(() => {
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'fallback',
                sessionId: 'session-a',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        await hook.unmount();
    });
});

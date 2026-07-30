import * as React from 'react';
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

        // A later legitimate cover must still be bounded rather than either lingering or being
        // revealed instantly by a spent deadline. Such a cover always belongs to the NEXT entry:
        // the first-paint fact only returns to unobserved when the session id changes, and an
        // entry that already revealed its painted rows never covers them again.
        await hook.rerender({
            ...coveredDeps,
            currentSessionIdRef: { current: 'session-b' },
            firstListPaintObserved: false,
            sessionId: 'session-b',
        });
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

        // The rows are painted: this is a refresh of presented content, which INV-5 forbids
        // re-covering.
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
    it('covers cold bottom content until Legend reports onLoad, then reveals it', async () => {
        // Cold: nothing is loaded when the entry begins, so these rows paint for the first time
        // inside the renderer's initial placement.
        const pendingDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: false,
            itemCount: 0,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: pendingDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        // Legend paints the tail entry from inside `finishInitialScroll`, so this frame already
        // sits where the landing settles it. No renderer confirmation is needed to reveal it.
        await hook.rerender({
            ...pendingDeps,
            firstListPaintObserved: true,
            isLoaded: true,
            itemCount: 10,
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

    // Live web repro (2026-07-29, sessions "Plugins SDK" / "Refine Plugin SDK Architecture"):
    // the renderer emits `started` and then NEVER emits its `finished` event, while the entry
    // owner confirms the observed alignment ~186ms later. Before this contract the join had no
    // affirmative terminal left and the transcript stayed behind the placeholder for ~1.7s,
    // until the bounded deadline revealed it with `deadline-fallback`.
    it('reveals a keyed entry on the owner confirming alignment when the renderer never finishes', async () => {
        vi.useFakeTimers();
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
        await hook.rerender({ ...pendingDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'confirmed',
                sessionId: 'session-a',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        // The bounded deadline is untouched and is no longer what reveals this entry.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    // The owner falling back has observed nothing, so the renderer finish stays load-bearing.
    it('keeps a keyed entry covered when the owner falls back and the renderer has not finished', async () => {
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
        await hook.rerender({ ...pendingDeps, firstListPaintObserved: true });

        act(() => {
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'fallback',
                sessionId: 'session-a',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                outcome: 'deadline',
                platform: 'web',
                type: 'finished',
            });
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });
});

describe('web Legend open placement cover', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    // A COLD bottom-entry open: nothing is loaded when the entry begins, so its rows paint for
    // the first time inside the renderer's initial placement — the window the landing hold
    // covers, which ends at that paint.
    function createWebBottomEntryDeps(
        overrides: Partial<TranscriptFirstPaintStateDeps> = {},
    ): TranscriptFirstPaintStateDeps {
        return createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: false,
            itemCount: 0,
            platformOS: 'web',
            rendererKind: 'legendList',
            ...overrides,
        });
    }

    function withColdRowsPainted(
        deps: TranscriptFirstPaintStateDeps,
    ): TranscriptFirstPaintStateDeps {
        return { ...deps, firstListPaintObserved: true, isLoaded: true, itemCount: 10 };
    }

    it('reveals a cold bottom-entry open on Legend onLoad instead of waiting for the landing', async () => {
        vi.useFakeTimers();
        const coldDeps = createWebBottomEntryDeps();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: coldDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        // `onLoad` (firstListPaintObserved) fires inside Legend's `finishInitialScroll`, which is
        // where the tail entry is placed. Its deferred at-end write only settles that position,
        // so holding these rows behind the placeholder for the landing confirmation — up to the
        // whole web initial pin stabilization window — conceals movement rather than a wrong
        // frame. The reveal must happen here, with no confirmation and no timer advanced.
        await hook.rerender(withColdRowsPainted(coldDeps));
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await hook.unmount();
    });

    it('reveals a warm bottom-entry open on its painted cached rows, not on the bounded deadline', async () => {
        vi.useFakeTimers();
        // The real warm/SWR shape: the store answers `isLoaded` together with its cached rows on
        // the transcript's FIRST render, so the landing hold arms before anything paints.
        const warmDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: true,
            itemCount: 10,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: warmDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        // Legend reports the cached rows painted. They are last-known-good content, so the
        // reveal must happen here — no renderer landing confirmation, no timer advanced.
        await hook.rerender({ ...warmDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await hook.unmount();
    });

    it('reveals a stalled renderer landing once the single bounded deadline elapses', async () => {
        vi.useFakeTimers();
        // A landing that never confirms AND rows that never paint: the placeholder still has a
        // terminal, and it is the single bounded deadline.
        const stalledDeps = createWebBottomEntryDeps({ isLoaded: true, itemCount: 10 });
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

    it('never holds the landing cover where no renderer produces the fact', async () => {
        const flashHook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: withColdRowsPainted(
                    createWebBottomEntryDeps({ rendererKind: 'flashList' }),
                ),
            },
        );
        expect(flashHook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        await flashHook.unmount();

        const nativeHook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            {
                initialProps: withColdRowsPainted(
                    createWebBottomEntryDeps({ platformOS: 'ios' }),
                ),
            },
        );
        expect(nativeHook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        await nativeHook.unmount();
    });

    it('stays terminal on a loaded empty transcript while the landing is still pending', async () => {
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: createWebBottomEntryDeps({ isLoaded: true, itemCount: 0 }) },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('leaves a keyed entry open to its existing entry join without a second landing hold', async () => {
        const keyedDeps = createDeps({
            firstListPaintObserved: true,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: keyedDeps },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'web',
                type: 'started',
            });
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                outcome: 'settled',
                platform: 'web',
                type: 'finished',
            });
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

    it('stays covered after the legacy paint release until the renderer finishes when the owner never confirmed', async () => {
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
                outcome: 'fallback',
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

    it('reveals a native keyed entry on owner confirmation without a renderer finish', async () => {
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
            // `fallback` keeps the renderer finish load-bearing, which is what makes the row
            // alias identity observable at all.
            hook.getCurrent().recordEntryOwnerOutcome({
                outcome: 'fallback',
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
                outcome: 'fallback',
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

describe('revealed transcript content is never re-covered', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    function createWebSwrDeps(
        overrides: Partial<TranscriptFirstPaintStateDeps> = {},
    ): TranscriptFirstPaintStateDeps {
        // A warm/SWR open: cached rows exist and paint while the session is still refreshing,
        // so every cover gate that needs `isLoaded` can only arm AFTER the reader sees content.
        return createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: false,
            itemCount: 10,
            platformOS: 'web',
            rendererKind: 'legendList',
            ...overrides,
        });
    }

    it('keeps cached rows visible when the open placement hold arms after they painted', async () => {
        const swrDeps = createWebSwrDeps();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: swrDeps },
        );

        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await hook.rerender({ ...swrDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        // The refresh lands: the loaded-data placement hold arms one render after the reader is
        // already looking at the cached rows. Re-covering them is the open flicker.
        await hook.rerender({ ...swrDeps, firstListPaintObserved: true, isLoaded: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('keeps cached rows visible when route hydration arms after they painted', async () => {
        const swrDeps = createWebSwrDeps();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: swrDeps },
        );

        await hook.rerender({ ...swrDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.rerender({
            ...swrDeps,
            firstListPaintObserved: true,
            isLoaded: true,
            routeHydrationPending: true,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);
        expect(hook.getCurrent().showRouteHydrationFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('still covers a native cold open through its placement, having revealed nothing yet', async () => {
        let nativePlacementSettled = false;
        const coldDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: false,
            itemCount: 0,
            platformOS: 'ios',
            rendererKind: 'legendList',
            sessionOpenLatch: {
                onNativeFirstPaintFallbackDeadline: () => ({ effects: [] }),
                shouldShowNativeFirstPaintPlaceholder: (input: Readonly<{
                    isLoaded: boolean;
                    itemCount: number;
                }>) => input.isLoaded && input.itemCount > 0 && !nativePlacementSettled,
            } as unknown as SessionOpenLatch,
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: coldDeps },
        );

        // Nothing is loaded and nothing painted: there is no content to cover and none revealed.
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.rerender({ ...coldDeps, isLoaded: true, itemCount: 10 });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        // Rows paint at position A UNDER the cover. Native deliberately keeps them covered until
        // the restore write lands, so the reader only ever sees the final position.
        await hook.rerender({
            ...coldDeps,
            firstListPaintObserved: true,
            isLoaded: true,
            itemCount: 10,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        nativePlacementSettled = true;
        await hook.rerender({
            ...coldDeps,
            firstListPaintObserved: true,
            isLoaded: true,
            itemCount: 10,
            nativeViewportPaintObserved: true,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        await hook.unmount();
    });

    it('covers a session opened again after an entry that revealed nothing', async () => {
        const swrDeps = createWebSwrDeps();
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: swrDeps },
        );

        await hook.rerender({ ...swrDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        // The same mounted transcript switches to a session that never reveals anything...
        await hook.rerender({
            ...swrDeps,
            currentSessionIdRef: { current: 'session-b' },
            sessionId: 'session-b',
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        // ...and back. This is a fresh entry: the earlier reveal belongs to the entry that ended,
        // so the open must cover again until this entry has something presentable.
        await hook.rerender({ ...swrDeps, currentSessionIdRef: { current: 'session-a' } });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await hook.unmount();
    });

    it('covers the next entry of the same session once the entry lifecycle drops the reveal record', async () => {
        vi.useFakeTimers();
        let nativePlacementPending = true;
        const nativeDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: true,
            itemCount: 10,
            platformOS: 'ios',
            rendererKind: 'legendList',
            sessionOpenLatch: {
                onNativeFirstPaintFallbackDeadline: () => ({ effects: [] }),
                shouldShowNativeFirstPaintPlaceholder: () => nativePlacementPending,
            } as unknown as SessionOpenLatch,
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: nativeDeps },
        );

        // First entry of this session: rows paint at A under the cover, the placement lands, and
        // the reader sees them at B.
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);
        nativePlacementPending = false;
        await hook.rerender({
            ...nativeDeps,
            firstListPaintObserved: true,
            nativeViewportPaintObserved: true,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        // The entry re-arms on an UNCHANGED session id (jump -> return, bottom <-> anchored). The
        // lifecycle clears the native reveal facts for the new entry, so this policy's own record
        // of the previous entry's reveal must clear with them: otherwise the new entry's placement
        // can never cover, and its paint-at-A -> settle-at-B write happens in front of the reader.
        nativePlacementPending = true;
        act(() => {
            hook.getCurrent().resetFirstPaintRevealRecordForSessionEntry();
        });
        await hook.rerender({
            ...nativeDeps,
            firstListPaintObserved: true,
            nativeViewportPaintObserved: false,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await hook.unmount();
    });

    it('keeps the entry reset when it lands in the same commit that observed the previous reveal', async () => {
        vi.useFakeTimers();
        // The entry lifecycle re-arms from a layout effect, which React flushes BEFORE the passive
        // effect that records this policy's reveal for the same commit. A reset that the stale
        // passive write could undo would leave the fix green in a unit test and dead in the app.
        const resetOnNextCommitRef: { current: boolean } = { current: false };
        let nativePlacementPending = true;
        const nativeDeps = createDeps({
            entryAnchorForRender: null,
            firstListPaintObserved: false,
            isLoaded: true,
            itemCount: 10,
            platformOS: 'ios',
            rendererKind: 'legendList',
            sessionOpenLatch: {
                onNativeFirstPaintFallbackDeadline: () => ({ effects: [] }),
                shouldShowNativeFirstPaintPlaceholder: () => nativePlacementPending,
            } as unknown as SessionOpenLatch,
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => {
                const state = useTranscriptFirstPaintState(deps);
                React.useLayoutEffect(() => {
                    if (!resetOnNextCommitRef.current) return;
                    resetOnNextCommitRef.current = false;
                    state.resetFirstPaintRevealRecordForSessionEntry();
                });
                return state;
            },
            { initialProps: nativeDeps },
        );

        nativePlacementPending = false;
        await hook.rerender({
            ...nativeDeps,
            firstListPaintObserved: true,
            nativeViewportPaintObserved: true,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(false);

        // The re-arm commit still renders the revealed transcript: the reset runs in its layout
        // phase, and the reveal write queued by the very same render must not restore the record.
        resetOnNextCommitRef.current = true;
        await hook.rerender({
            ...nativeDeps,
            firstListPaintObserved: true,
            nativeViewportPaintObserved: true,
        });

        nativePlacementPending = true;
        await hook.rerender({
            ...nativeDeps,
            firstListPaintObserved: true,
            nativeViewportPaintObserved: false,
        });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await hook.unmount();
    });

    it('still covers a keyed entry that paints before its placement joins', async () => {
        const keyedDeps = createDeps({
            firstListPaintObserved: false,
            platformOS: 'web',
            rendererKind: 'legendList',
        });
        const hook = await renderHook(
            (deps: TranscriptFirstPaintStateDeps) => useTranscriptFirstPaintState(deps),
            { initialProps: keyedDeps },
        );

        act(() => {
            hook.getCurrent().onEntryPlacementEvent({
                dataKey: 'session-a',
                itemId: 'row-42',
                platform: 'web',
                type: 'started',
            });
        });
        await hook.rerender({ ...keyedDeps, firstListPaintObserved: true });
        expect(hook.getCurrent().showFirstPaintPlaceholder).toBe(true);

        await hook.unmount();
    });
});

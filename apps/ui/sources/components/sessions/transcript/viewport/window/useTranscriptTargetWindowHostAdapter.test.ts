import { describe, expect, it, vi } from 'vitest';

import {
    executeTranscriptTargetWindowJump,
    resolveTranscriptTargetWindowHostFacts,
} from './useTranscriptTargetWindowHostAdapter';
import type { TranscriptTargetWindowState } from './transcriptTargetWindowTypes';

const inactiveState: TranscriptTargetWindowState = {
    activatedAtMs: null,
    hasMoreNewer: null,
    hasMoreOlder: null,
    isWindowMode: false,
    newerCursor: null,
    olderCursor: null,
    targetSeq: null,
    windowId: null,
    windowMaxSeq: null,
    windowMinSeq: null,
};

describe('transcript target-window host adapter', () => {
    it('keeps tail display inactive when the session has no active target window', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [{ id: 'row-1', seq: 1 }],
            windowState: inactiveState,
        });

        expect(facts.targetWindowActive).toBe(false);
        expect(facts.items).toEqual([{ id: 'row-1', seq: 1 }]);
        expect(facts.hasMoreNewer).toBe(false);
    });

    it('derives display items and hasMoreNewer from active window state instead of hard-coding false', () => {
        const facts = resolveTranscriptTargetWindowHostFacts({
            items: [
                { id: 'row-1', seq: 98 },
                { id: 'row-2', seq: 99 },
                { id: 'row-3', seq: 100 },
                { id: 'row-4', seq: 250 },
            ],
            windowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 100,
                olderCursor: 98,
                targetSeq: 99,
                windowId: 'window-99',
                windowMaxSeq: 100,
                windowMinSeq: 98,
            },
        });

        expect(facts.targetWindowActive).toBe(true);
        expect(facts.hasMoreNewer).toBe(true);
        expect(facts.display?.windowId).toBe('window-99');
        expect(facts.items.map((item) => item.id)).toEqual(['row-1', 'row-2', 'row-3']);
    });

    it('forces a target-window render when a mounted scroll reports no real movement', async () => {
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-500' }));
        const onJumpLanded = vi.fn();

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow,
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: vi.fn()
                .mockReturnValueOnce(100)
                .mockReturnValueOnce(100),
            resolveTargetIndex: () => ({ status: 'found', index: 2, seq: 500, routeMessageId: null }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 500 },
            windowId: 'window-500',
        });
        expect(loadTargetWindow).toHaveBeenCalledWith({
            direction: null,
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('forces a target-window render when a web mounted scroll moves but the target is still not mounted', async () => {
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-331' }));
        const onJumpLanded = vi.fn();

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow,
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: vi.fn()
                .mockReturnValueOnce(10_820)
                .mockReturnValueOnce(10_548),
            resolveTargetIndex: () => ({ status: 'found', index: 29, seq: 331, routeMessageId: 'server:m331' }),
            scrollToTarget: vi.fn(() => true),
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 331 },
            windowId: 'window-331',
        });
        expect(loadTargetWindow).toHaveBeenCalledWith({
            direction: null,
            target: { kind: 'seq', seq: 331 },
            targetSeq: 331,
        });
        expect(onJumpLanded).not.toHaveBeenCalled();
    });

    it('does not issue an ad-hoc newer page after target-window activation', async () => {
        const loadTargetWindow = vi.fn(async (request: { direction: 'older' | 'newer' | null }) => (
            request.direction === 'newer'
                ? { windowId: 'window-253', targetSeq: 253, newerCursor: 258, hasMoreNewer: true }
                : { windowId: 'window-253', targetSeq: 253, newerCursor: 253, hasMoreNewer: true }
        ));

        const result = await executeTranscriptTargetWindowJump({
            align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
            canRenderTargetWindow: true,
            isTargetMounted: () => true,
            loadTargetWindow,
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => false),
            target: { kind: 'seq', seq: 253 },
            targetSeq: 253,
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 253 },
            windowId: 'window-253',
        });
        expect(loadTargetWindow).toHaveBeenNthCalledWith(1, {
            direction: null,
            target: { kind: 'seq', seq: 253 },
            targetSeq: 253,
        });
        expect(loadTargetWindow).toHaveBeenCalledTimes(1);
    });

    it('maps stale target-window loads to an aborted jump result', async () => {
        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow: vi.fn(async () => ({ status: 'stale' as const })),
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => false),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });

        expect(result).toEqual({ status: 'aborted' });
    });

    it('fires web target-window landing after the rendered target becomes mounted', async () => {
        const onJumpLanded = vi.fn();
        const isTargetMounted = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted,
            loadTargetWindow: vi.fn(async () => ({ windowId: 'window-500' })),
            onJumpLanded,
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({ status: 'not-found', reason: 'unavailable' }),
            scrollToTarget: vi.fn(() => false),
            target: { kind: 'seq', seq: 500 },
            targetSeq: 500,
        });

        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 500 },
            windowId: 'window-500',
        });
        expect(onJumpLanded).toHaveBeenCalledTimes(1);
        expect(onJumpLanded).toHaveBeenCalledWith(result);
    });

    it('pages nearby unresolved targets before replacing the list with a target window', async () => {
        const pageTowardTarget = vi.fn(async () => ({
            status: 'scrolled' as const,
            target: { kind: 'seq' as const, seq: 103 },
        }));
        const loadTargetWindow = vi.fn(async () => ({ windowId: 'window-103' }));

        const result = await executeTranscriptTargetWindowJump({
            canRenderTargetWindow: true,
            isTargetMounted: () => false,
            loadTargetWindow,
            pageTowardTarget,
            platformOS: 'web',
            readScrollTop: () => null,
            resolveTargetIndex: () => ({
                status: 'unresolved',
                direction: 'older',
                targetSeq: 103,
                nearestIndex: 0,
                nearestSeq: 100,
            }),
            scrollToTarget: vi.fn(() => false),
            target: { kind: 'seq', seq: 103 },
            targetSeq: 103,
        });

        expect(result).toEqual({ status: 'scrolled', target: { kind: 'seq', seq: 103 } });
        expect(pageTowardTarget).toHaveBeenCalledWith({
            direction: 'older',
            nearestIndex: 0,
            nearestSeq: 100,
            target: { kind: 'seq', seq: 103 },
            targetSeq: 103,
        });
        expect(loadTargetWindow).not.toHaveBeenCalled();
    });
});

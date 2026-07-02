import { describe, expect, it, vi } from 'vitest';

import {
    applySidechainInitialBottomPin,
    applySidechainInitialBottomPinRequest,
    resolveSidechainInitialBottomPinPlan,
} from './sidechainInitialBottomPin';

describe('sidechain initial bottom pin', () => {
    it('plans no-op states before issuing any raw list command', () => {
        expect(resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 120,
            hasJumpTarget: true,
            itemCount: 3,
            layoutHeightPx: 300,
        })).toEqual({ ok: false, reason: 'jump-target' });

        expect(resolveSidechainInitialBottomPinPlan({
            alreadyApplied: true,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 120,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        })).toEqual({ ok: false, reason: 'already-applied' });

        expect(resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: true,
            estimatedItemSizePx: 120,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        })).toEqual({ ok: false, reason: 'local-interaction' });

        expect(resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 120,
            hasJumpTarget: false,
            itemCount: 0,
            layoutHeightPx: 300,
        })).toEqual({ ok: false, reason: 'empty' });

        expect(resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 0,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 120,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        })).toEqual({ ok: false, reason: 'not-ready' });
    });

    it('targets the last transcript item and never scrolls into footer chrome', () => {
        const plan = resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        });

        expect(plan).toEqual({
            ok: true,
            targetIndex: 2,
        });

        const scrollToIndex = vi.fn(() => Promise.resolve());
        const scrollToOffset = vi.fn();
        const scrollToEnd = vi.fn();
        const listRef = { scrollToEnd, scrollToIndex, scrollToOffset };
        applySidechainInitialBottomPin({
            estimatedItemSizePx: 88,
            listRef,
            plan,
        });

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewPosition: 1,
        });
        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(scrollToEnd).not.toHaveBeenCalled();
    });

    it('targets index zero for native newest-first inverted data', () => {
        const plan = resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'newest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        });

        expect(plan).toEqual({
            ok: true,
            targetIndex: 0,
        });

        const scrollToIndex = vi.fn(() => Promise.resolve());
        applySidechainInitialBottomPin({
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex },
            plan,
        });

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 0,
            animated: false,
            viewPosition: 1,
        });
    });

    it('falls back to the estimated target offset when scrollToIndex rejects', async () => {
        const plan = resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        });
        const scrollToIndex = vi.fn(() => Promise.reject(new Error('missing layout')));
        const scrollToOffset = vi.fn();
        const scrollToEnd = vi.fn();
        const listRef = { scrollToEnd, scrollToIndex, scrollToOffset };

        applySidechainInitialBottomPin({
            estimatedItemSizePx: 88,
            listRef,
            plan,
        });
        await Promise.resolve();

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 176, animated: false });
        expect(scrollToEnd).not.toHaveBeenCalled();
    });

    it('keeps no-op initial bottom-pin requests from marking the pin applied', () => {
        const setAlreadyApplied = vi.fn();

        expect(applySidechainInitialBottomPinRequest({
            alreadyApplied: true,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
            listRef: {
                scrollToIndex: vi.fn(),
            },
            setAlreadyApplied,
        })).toEqual({ ok: false, reason: 'already-applied' });

        expect(setAlreadyApplied).not.toHaveBeenCalled();
    });

    it('marks the initial bottom pin applied before issuing the driver-owned list command', () => {
        const events: string[] = [];
        const scrollToIndex = vi.fn(() => {
            events.push('scrollToIndex');
        });

        expect(applySidechainInitialBottomPinRequest({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
            listRef: { scrollToIndex },
            setAlreadyApplied: (applied) => {
                events.push(`applied:${applied}`);
            },
        })).toEqual({
            ok: true,
            applied: true,
            plan: {
                ok: true,
                targetIndex: 2,
            },
        });

        expect(events).toEqual(['applied:true', 'scrollToIndex']);
        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewPosition: 1,
        });
    });

    it('preserves the legacy applied-before-command behavior when the list ref is unavailable', () => {
        const setAlreadyApplied = vi.fn();

        expect(applySidechainInitialBottomPinRequest({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
            listRef: null,
            setAlreadyApplied,
        })).toEqual({
            ok: true,
            applied: false,
            plan: {
                ok: true,
                targetIndex: 2,
            },
        });

        expect(setAlreadyApplied).toHaveBeenCalledOnce();
        expect(setAlreadyApplied).toHaveBeenCalledWith(true);
    });
});

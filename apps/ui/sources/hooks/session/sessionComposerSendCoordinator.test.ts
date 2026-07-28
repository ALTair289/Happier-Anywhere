import { describe, expect, it, vi } from 'vitest';

import {
    captureComposerTransientInputStateForOutboundHandoff,
    clearComposerAfterOutboundHandoff,
    restoreComposerAfterFailedOutboundHandoff,
} from './sessionComposerSendCoordinator';

describe('sessionComposerSendCoordinator', () => {
    it('captures transient input handlers for the outbound lifecycle before owner refs change', () => {
        const ownerAState = { expanded: true, scrollY: 42, updatedAt: 1 };
        const captureOwnerA = vi.fn(() => ownerAState);
        const clearOwnerA = vi.fn();
        const restoreOwnerA = vi.fn();
        const captureOwnerB = vi.fn(() => null);
        const clearOwnerB = vi.fn();
        const restoreOwnerB = vi.fn();

        const captured = captureComposerTransientInputStateForOutboundHandoff({
            captureTransientInputState: captureOwnerA,
            clearTransientInputState: clearOwnerA,
            restoreTransientInputState: restoreOwnerA,
        });

        const currentHandlers = {
            captureTransientInputState: captureOwnerB,
            clearTransientInputState: clearOwnerB,
            restoreTransientInputState: restoreOwnerB,
        };
        currentHandlers.clearTransientInputState();
        currentHandlers.restoreTransientInputState(null);

        captured.clearTransientInputState();
        captured.restoreTransientInputState();

        expect(captureOwnerA).toHaveBeenCalledTimes(1);
        expect(captured.transientInputStateSnapshot).toBe(ownerAState);
        expect(clearOwnerA).toHaveBeenCalledTimes(1);
        expect(restoreOwnerA).toHaveBeenCalledWith(ownerAState);
        expect(captureOwnerB).not.toHaveBeenCalled();
        expect(clearOwnerB).toHaveBeenCalledTimes(1);
        expect(restoreOwnerB).toHaveBeenCalledWith(null);
    });

    it('clears transient input state when the submitted snapshot is handed off and still matches', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const clearTransientInputState = vi.fn();
        const isSemanticSnapshotCurrent = vi.fn(() => true);
        const clearSemanticDraftValues = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            isSemanticSnapshotCurrent,
            clearSemanticDraftValues,
        });

        expect(didClear).toBe(true);
        expect(clearDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        });
        expect(isSemanticSnapshotCurrent).toHaveBeenCalledTimes(1);
        expect(clearSemanticDraftValues).toHaveBeenCalledTimes(1);
        expect(clearTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('does not clear transient input state when the user has typed a newer draft before handoff', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => false);
        const clearTransientInputState = vi.fn();
        const clearSemanticDraftValues = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            isSemanticSnapshotCurrent: () => true,
            clearSemanticDraftValues,
        });

        expect(didClear).toBe(false);
        expect(clearSemanticDraftValues).not.toHaveBeenCalled();
        expect(clearTransientInputState).not.toHaveBeenCalled();
    });

    it('does not clear text or semantic values when semantic draft state changed before handoff', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const clearTransientInputState = vi.fn();
        const clearSemanticDraftValues = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            isSemanticSnapshotCurrent: () => false,
            clearSemanticDraftValues,
        });

        expect(didClear).toBe(false);
        expect(clearDraftForSessionIfCurrentValueMatches).not.toHaveBeenCalled();
        expect(clearSemanticDraftValues).not.toHaveBeenCalled();
        expect(clearTransientInputState).not.toHaveBeenCalled();
    });

    it('restores a cleared snapshot after failed handoff only while the composer is still empty', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValues = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValues,
        });

        expect(didRestore).toBe(true);
        expect(restoreDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        }, '');
        expect(restoreSemanticDraftValues).toHaveBeenCalledTimes(1);
        expect(restoreTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('does not restore after the submitted local id reaches a canonical message owner', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValues = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => true,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValues,
        });

        expect(didRestore).toBe(false);
        expect(restoreDraftForSessionIfCurrentValueMatches).not.toHaveBeenCalled();
        expect(restoreSemanticDraftValues).not.toHaveBeenCalled();
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });

    it('does not restore a failed handoff over a newer draft', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => false);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValues = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValues,
        });

        expect(didRestore).toBe(false);
        expect(restoreSemanticDraftValues).not.toHaveBeenCalled();
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });

    it('does not restore a failed handoff over newer semantic state', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValues = vi.fn();
        const isSemanticRestoreSafe = vi.fn(() => false);

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            isSemanticRestoreSafe,
            restoreTransientInputState,
            restoreSemanticDraftValues,
        });

        expect(didRestore).toBe(false);
        expect(isSemanticRestoreSafe).toHaveBeenCalledTimes(1);
        expect(restoreDraftForSessionIfCurrentValueMatches).not.toHaveBeenCalled();
        expect(restoreSemanticDraftValues).not.toHaveBeenCalled();
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });
});

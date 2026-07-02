import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import {
    planSessionListRenderableMerge,
    planSessionListRenderablePatches,
    planSessionListRenderableReplacement,
} from './sessionListRenderableStoreUpdate';

function makeRenderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('sessionListRenderableStoreUpdate', () => {
    it('merges incoming renderables without removing existing rows omitted from an append page', () => {
        const previous = makeRenderable('s_existing', { createdAt: 10 });
        const appended = makeRenderable('s_appended', { createdAt: 5 });
        const plan = planSessionListRenderableMerge({
            previousRenderables: { s_existing: previous },
            incomingRenderables: [appended],
            isSessionListViewDataUninitialized: false,
        });

        expect(plan.nextRenderables.s_existing).toBe(previous);
        expect(plan.nextRenderables.s_appended).toEqual(expect.objectContaining({
            id: appended.id,
            createdAt: appended.createdAt,
        }));
        expect(plan.changedCount).toBe(1);
        expect(plan.removedCount).toBe(0);
        expect(plan.needsSessionListViewDataRebuild).toBe(true);
    });

    it('keeps merge no-op when an append page only repeats existing equivalent renderables', () => {
        const previous = makeRenderable('s_existing', { createdAt: 10 });
        const plan = planSessionListRenderableMerge({
            previousRenderables: { s_existing: previous },
            incomingRenderables: [{ ...previous, metadata: previous.metadata ? { ...previous.metadata } : null }],
            isSessionListViewDataUninitialized: false,
        });

        expect(plan.nextRenderables.s_existing).toBe(previous);
        expect(plan.noop).toBe(true);
        expect(plan.changedCount).toBe(0);
        expect(plan.removedCount).toBe(0);
        expect(plan.needsSessionListViewDataRebuild).toBe(false);
    });

    it('does not rebuild list data for attention-only replacement changes when attention promotion is disabled', () => {
        const previous = makeRenderable('s1', { latestReadyEventSeq: null });
        const plan = planSessionListRenderableReplacement({
            previousRenderables: { s1: previous },
            incomingRenderables: [{ ...previous, latestReadyEventSeq: 4 }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('rebuilds list data for attention-only replacement changes when attention promotion is enabled', () => {
        const previous = makeRenderable('s1', { latestReadyEventSeq: null });
        const plan = planSessionListRenderableReplacement({
            previousRenderables: { s1: previous },
            incomingRenderables: [{ ...previous, latestReadyEventSeq: 4 }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('rebuilds list data for attention-only patch changes when attention promotion is enabled', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: now - 1_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{ sessionId: 's1', patch: { hasPendingUserActionRequests: true } }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('does not rebuild list data for heartbeat-only thinking freshness changes while promotion state is unchanged', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: now - 1_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{ sessionId: 's1', patch: { thinkingAt: now - 500 } }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.attentionPromotionFieldChangeCount).toBe(0);
    });

    it('rebuilds list data when a stale retained working candidate becomes terminal', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 600_000,
            activeAt: now - 600_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('defers warm-cache persistence for active heartbeat progress patches', () => {
        const previous = makeRenderable('s1', {
            active: true,
            activeAt: 100,
            updatedAt: 100,
            presence: 'online',
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    activeAt: 200,
                    updatedAt: 200,
                    presence: 'online',
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
        expect(plan.didImmediateWarmCacheRelevantRenderableChange).toBe(false);
        expect(plan.didDeferredWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('defers warm-cache persistence for runtime activity lease-only patches', () => {
        const previous = makeRenderable('s1', {
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 100,
            runtimeActivityExpiresAt: Date.now() + 60_000,
            runtimeActivitySourceClass: 'provider_detached_task',
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    runtimeActivityObservedAt: 200,
                    runtimeActivityExpiresAt: Date.now() + 120_000,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toEqual(['s1']);
        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
        expect(plan.didImmediateWarmCacheRelevantRenderableChange).toBe(false);
        expect(plan.didDeferredWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('marks latest turn projection patches as warm-cache relevant', () => {
        const previous = makeRenderable('s1', {
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
            rollbackEligibleTurnStarts: [1],
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    latestTurnId: 'turn-2',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 200,
                    rollbackEligibleTurnStarts: [1, 3],
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('marks session read-model patches as warm-cache relevant', () => {
        const previous = makeRenderable('s1', {
            seq: 10,
            lastViewedSessionSeq: 8,
            latestReadyEventSeq: 9,
            latestReadyEventAt: 100,
            hasUnreadMessages: true,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    seq: 11,
                    lastViewedSessionSeq: 10,
                    latestReadyEventSeq: 11,
                    latestReadyEventAt: 200,
                    hasUnreadMessages: false,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('treats pending, unread, and request row updates as overlay-only when placement does not change', () => {
        const previous = makeRenderable('s1', {
            pendingCount: 0,
            pendingBlockedCount: 0,
            hasUnreadMessages: false,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: null,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    pendingCount: 2,
                    pendingBlockedCount: 1,
                    hasUnreadMessages: true,
                    hasPendingUserActionRequests: true,
                    pendingRequestObservedAt: 200,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.changedCount).toBe(1);
        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toEqual([]);
        expect(plan.nextRenderables.s1.pendingBlockedCount).toBe(1);
        expect(plan.nextRenderables.s1.hasPendingUserActionRequests).toBe(true);
    });
});

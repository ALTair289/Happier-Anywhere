import {
    areSessionListRenderablesEqual,
    applySessionListRenderablePatch,
    didSessionListRenderableAttentionPromotionFieldsChange,
    didSessionListRenderableStructuralFieldsChange,
    didSessionListRenderableWarmCacheFieldsChange,
    isSessionListRenderableRuntimeActivityLeaseOnlyChange,
    isSessionListRenderableWarmCacheProgressOnlyChange,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    type SessionListRenderablePatchFields,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import { nowServerMs } from '../../runtime/time';

export type SessionListRenderablePatch = Readonly<{
    sessionId: string;
    patch: SessionListRenderablePatchFields;
}>;

export type SessionListRenderableStoreUpdatePlan = Readonly<{
    nextRenderables: Record<string, SessionListRenderableSession>;
    noop: boolean;
    changedCount: number;
    removedCount: number;
    missingCount: number;
    noopPatchCount: number;
    listViewFieldChangeCount: number;
    listViewRowRefreshSessionIds: readonly string[];
    attentionPromotionFieldChangeCount: number;
    staleMetadataPreservedCount: number;
    stalePendingFlagsPreservedCount: number;
    needsSessionListViewDataRebuild: boolean;
    didWarmCacheRelevantRenderableChange: boolean;
    didImmediateWarmCacheRelevantRenderableChange: boolean;
    didDeferredWarmCacheRelevantRenderableChange: boolean;
}>;

type DidListViewFieldsChange = (
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
) => boolean;

type DidListViewRowFieldsChange = (
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
) => boolean;

function didPreserveMetadata(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    return incoming.metadata == null
        && previous?.metadata != null
        && next.metadata === previous.metadata
        && next.metadataVersion === previous.metadataVersion;
}

function didPreservePendingFlags(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    return incoming.active === true
        && typeof incoming.hasPendingPermissionRequests !== 'boolean'
        && typeof incoming.hasPendingUserActionRequests !== 'boolean'
        && next.agentStateVersion === previous.agentStateVersion
        && (
            next.hasPendingPermissionRequests === previous.hasPendingPermissionRequests
            || next.hasPendingUserActionRequests === previous.hasPendingUserActionRequests
        );
}

function isDeferredWarmCacheOnlyRenderableChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    return isSessionListRenderableWarmCacheProgressOnlyChange(previous, next)
        || isSessionListRenderableRuntimeActivityLeaseOnlyChange({
            previous,
            next,
            nowMs: nowServerMs(),
        });
}

function shouldRefreshListViewRowForRenderableChange(input: Readonly<{
    previous: SessionListRenderableSession | undefined;
    next: SessionListRenderableSession;
    didListViewFieldsChange: boolean;
    didListViewRowFieldsChange: boolean;
}>): boolean {
    if (input.didListViewFieldsChange) return false;
    if (input.didListViewRowFieldsChange) return true;
    return isSessionListRenderableRuntimeActivityLeaseOnlyChange({
        previous: input.previous,
        next: input.next,
        nowMs: nowServerMs(),
    });
}

function planSessionListRenderableIncomingRows(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
    removeOmittedPreviousRenderables: boolean;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    const previousRenderables = input.previousRenderables;
    const previousIds = Object.keys(previousRenderables);
    const incomingIds = new Set<string>();
    let nextRenderables = previousRenderables;
    let didAnyRenderableChange = input.removeOmittedPreviousRenderables
        ? previousIds.length !== input.incomingRenderables.length
        : false;
    let changedCount = 0;
    let removedCount = 0;
    let listViewFieldChangeCount = 0;
    const listViewRowRefreshSessionIds: string[] = [];
    let attentionPromotionFieldChangeCount = 0;
    let staleMetadataPreservedCount = 0;
    let stalePendingFlagsPreservedCount = 0;
    let needsSessionListViewDataRebuild = input.isSessionListViewDataUninitialized;
    let didImmediateWarmCacheRelevantRenderableChange = false;
    let didDeferredWarmCacheRelevantRenderableChange = false;

    for (const incomingRenderable of input.incomingRenderables) {
        incomingIds.add(incomingRenderable.id);
        const previousRenderable = previousRenderables[incomingRenderable.id];
        const stalePreservedRenderable = preserveSessionListRenderableStaleFields(previousRenderable, incomingRenderable);
        const nextRenderableBase = preserveSessionListRenderableTransientState(
            previousRenderable,
            stalePreservedRenderable,
        );
        const nextRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderableBase)
            ? previousRenderable
            : nextRenderableBase;

        if (didPreserveMetadata(previousRenderable, incomingRenderable, nextRenderable)) {
            staleMetadataPreservedCount += 1;
        }
        if (didPreservePendingFlags(previousRenderable, incomingRenderable, nextRenderable)) {
            stalePendingFlagsPreservedCount += 1;
        }

        const didListViewFieldsChange = input.didListViewFieldsChange
            ? input.didListViewFieldsChange(previousRenderable, nextRenderable)
            : didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable);
        const didListViewRowFieldsChange = input.didListViewRowFieldsChange
            ? input.didListViewRowFieldsChange(previousRenderable, nextRenderable)
            : false;
        const didAttentionPromotionFieldsChange = didSessionListRenderableAttentionPromotionFieldsChange(previousRenderable, nextRenderable);

        if (!previousRenderable || nextRenderable !== previousRenderable) {
            didAnyRenderableChange = true;
            changedCount += 1;
            if (didListViewFieldsChange) {
                listViewFieldChangeCount += 1;
            }
            if (shouldRefreshListViewRowForRenderableChange({
                previous: previousRenderable,
                next: nextRenderable,
                didListViewFieldsChange,
                didListViewRowFieldsChange,
            })) {
                listViewRowRefreshSessionIds.push(incomingRenderable.id);
            }
            if (didAttentionPromotionFieldsChange) {
                attentionPromotionFieldChangeCount += 1;
            }
            if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable)) {
                if (
                    !didListViewFieldsChange
                    && !didAttentionPromotionFieldsChange
                    && isDeferredWarmCacheOnlyRenderableChange(previousRenderable, nextRenderable)
                ) {
                    didDeferredWarmCacheRelevantRenderableChange = true;
                } else {
                    didImmediateWarmCacheRelevantRenderableChange = true;
                }
            }
            if (nextRenderables === previousRenderables) {
                nextRenderables = { ...previousRenderables };
            }
            nextRenderables[incomingRenderable.id] = nextRenderable;
        }

        if (!needsSessionListViewDataRebuild) {
            if (didListViewFieldsChange || (input.rebuildOnAttentionPromotionFieldsChange === true && didAttentionPromotionFieldsChange)) {
                needsSessionListViewDataRebuild = true;
            }
        }
    }

    if (input.removeOmittedPreviousRenderables) {
        for (const sessionId of previousIds) {
            if (!incomingIds.has(sessionId)) {
                if (nextRenderables === previousRenderables) {
                    nextRenderables = { ...previousRenderables };
                }
                delete nextRenderables[sessionId];
                removedCount += 1;
                didImmediateWarmCacheRelevantRenderableChange = true;
                needsSessionListViewDataRebuild = true;
            }
        }
    }

    return {
        nextRenderables,
        noop: !didAnyRenderableChange && !needsSessionListViewDataRebuild,
        changedCount,
        removedCount,
        missingCount: 0,
        noopPatchCount: 0,
        listViewFieldChangeCount,
        listViewRowRefreshSessionIds,
        attentionPromotionFieldChangeCount,
        staleMetadataPreservedCount,
        stalePendingFlagsPreservedCount,
        needsSessionListViewDataRebuild,
        didWarmCacheRelevantRenderableChange: didImmediateWarmCacheRelevantRenderableChange || didDeferredWarmCacheRelevantRenderableChange,
        didImmediateWarmCacheRelevantRenderableChange,
        didDeferredWarmCacheRelevantRenderableChange,
    };
}

export function planSessionListRenderableReplacement(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    return planSessionListRenderableIncomingRows({
        ...input,
        removeOmittedPreviousRenderables: true,
    });
}

export function planSessionListRenderableMerge(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    return planSessionListRenderableIncomingRows({
        ...input,
        removeOmittedPreviousRenderables: false,
    });
}

export function planSessionListRenderablePatches(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    patches: ReadonlyArray<SessionListRenderablePatch>;
    isSessionListViewDataUninitialized: boolean;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    const previousRenderables = input.previousRenderables;
    let nextRenderables = previousRenderables;
    let changedCount = 0;
    let missingCount = 0;
    let noopPatchCount = 0;
    let listViewFieldChangeCount = 0;
    const listViewRowRefreshSessionIds: string[] = [];
    let attentionPromotionFieldChangeCount = 0;
    let needsSessionListViewDataRebuild = input.isSessionListViewDataUninitialized;
    let didImmediateWarmCacheRelevantRenderableChange = false;
    let didDeferredWarmCacheRelevantRenderableChange = false;

    for (const { sessionId, patch } of input.patches) {
        const previousRenderable = nextRenderables[sessionId];
        if (!previousRenderable) {
            missingCount += 1;
            continue;
        }

        const nextRenderable = applySessionListRenderablePatch(previousRenderable, patch);

        if (areSessionListRenderablesEqual(previousRenderable, nextRenderable)) {
            noopPatchCount += 1;
            continue;
        }

        changedCount += 1;
        const didListViewFieldsChange = input.didListViewFieldsChange
            ? input.didListViewFieldsChange(previousRenderable, nextRenderable)
            : didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable);
        const didListViewRowFieldsChange = input.didListViewRowFieldsChange
            ? input.didListViewRowFieldsChange(previousRenderable, nextRenderable)
            : false;
        const didAttentionPromotionFieldsChange = didSessionListRenderableAttentionPromotionFieldsChange(previousRenderable, nextRenderable);
        if (didListViewFieldsChange) {
            listViewFieldChangeCount += 1;
        }
        if (shouldRefreshListViewRowForRenderableChange({
            previous: previousRenderable,
            next: nextRenderable,
            didListViewFieldsChange,
            didListViewRowFieldsChange,
        })) {
            listViewRowRefreshSessionIds.push(sessionId);
        }
        if (didAttentionPromotionFieldsChange) {
            attentionPromotionFieldChangeCount += 1;
        }
        if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable)) {
            if (
                !didListViewFieldsChange
                && !didAttentionPromotionFieldsChange
                && isDeferredWarmCacheOnlyRenderableChange(previousRenderable, nextRenderable)
            ) {
                didDeferredWarmCacheRelevantRenderableChange = true;
            } else {
                didImmediateWarmCacheRelevantRenderableChange = true;
            }
        }

        if (!needsSessionListViewDataRebuild) {
            if (didListViewFieldsChange || (input.rebuildOnAttentionPromotionFieldsChange === true && didAttentionPromotionFieldsChange)) {
                needsSessionListViewDataRebuild = true;
            }
        }

        if (nextRenderables === previousRenderables) {
            nextRenderables = { ...previousRenderables };
        }
        nextRenderables[sessionId] = nextRenderable;
    }

    return {
        nextRenderables,
        noop: nextRenderables === previousRenderables && !needsSessionListViewDataRebuild,
        changedCount,
        removedCount: 0,
        missingCount,
        noopPatchCount,
        listViewFieldChangeCount,
        listViewRowRefreshSessionIds,
        attentionPromotionFieldChangeCount,
        staleMetadataPreservedCount: 0,
        stalePendingFlagsPreservedCount: 0,
        needsSessionListViewDataRebuild,
        didWarmCacheRelevantRenderableChange: didImmediateWarmCacheRelevantRenderableChange || didDeferredWarmCacheRelevantRenderableChange,
        didImmediateWarmCacheRelevantRenderableChange,
        didDeferredWarmCacheRelevantRenderableChange,
    };
}

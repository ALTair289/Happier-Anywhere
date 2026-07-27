import type {
    TranscriptListShellRef,
    TranscriptRendererVisibleSourceIndexRange,
} from '@/components/sessions/transcript/viewport/shell/renderer/types';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';

import {
    deriveCurrentTranscriptAnchor,
    type TranscriptNavigationAnchorCandidate,
    type TranscriptVisibleSourceRange,
} from './deriveCurrentTranscriptAnchor';
import {
    EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
    type NavigationVisibilitySnapshot,
    type NavigationVisibilityStore,
} from './transcriptNavigationVisibilityStore';

/**
 * The renderer's own visible-index window (`readVisibleSourceIndexRange`), in
 * the same source-index space as `listData` — the ONE viewport fact navigation
 * visibility consumes on web and native, Legend and FlashList alike.
 */
export type TranscriptRendererVisibleIndexRange = TranscriptRendererVisibleSourceIndexRange;

/**
 * The mounted transcript list is described by two mirrored first-party handle
 * types: the renderer seam's `TranscriptListShellRef`, which declares the
 * navigation reader, and the command-side `ScrollableChatListRef` the hosts
 * hold. Resolving the reader HERE keeps the bridge between those two shapes in
 * one place instead of spreading it over every publish trigger; deleting it is
 * a one-line change once `ScrollableChatListRef` declares the reader too.
 */
export function readRendererVisibleSourceIndexRange(
    listNode: ScrollableChatListRef | TranscriptListShellRef | null | undefined,
): TranscriptRendererVisibleSourceIndexRange | null {
    const read = (listNode as Pick<TranscriptListShellRef, 'readVisibleSourceIndexRange'> | null | undefined)
        ?.readVisibleSourceIndexRange;
    return read?.() ?? null;
}

export type TranscriptNavigationVisibilityWriteDecision =
    | Readonly<{ kind: 'write'; snapshot: NavigationVisibilitySnapshot }>
    | Readonly<{ kind: 'skip'; reason: 'unmeasured-viewport' | 'no-subscribers' }>;

function normalizeVisibleSourceRange(
    range: TranscriptRendererVisibleIndexRange | null | undefined,
    itemCount: number,
): TranscriptVisibleSourceRange | null {
    if (!Number.isInteger(itemCount) || itemCount <= 0) return null;
    if (!range) return null;
    const { startIndex, endIndex } = range;
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
    const low = Math.trunc(Math.min(startIndex, endIndex));
    const high = Math.trunc(Math.max(startIndex, endIndex));
    if (low < 0 || low >= itemCount) return null;
    return {
        firstSourceIndex: low,
        lastSourceIndex: Math.min(high, itemCount - 1),
    };
}

/**
 * Distinguishes the two "nothing to show" cases explicitly.
 *
 * - A genuinely empty anchor set writes the empty snapshot: the rail must clear.
 * - An unmeasured / detached frame (no renderer range, or no rendered items)
 *   SKIPS, so a transient zero-height layout pass cannot blanket-clobber a good
 *   snapshot with empty and blank every marker.
 */
export function resolveTranscriptNavigationVisibilityWrite(input: Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    itemCount: number;
    visibleSourceRange: TranscriptRendererVisibleIndexRange | null | undefined;
}>): TranscriptNavigationVisibilityWriteDecision {
    if (input.anchors.length === 0) {
        return { kind: 'write', snapshot: EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT };
    }
    const visibleSourceRange = normalizeVisibleSourceRange(input.visibleSourceRange, input.itemCount);
    if (!visibleSourceRange) return { kind: 'skip', reason: 'unmeasured-viewport' };
    return {
        kind: 'write',
        snapshot: deriveCurrentTranscriptAnchor({
            anchors: input.anchors,
            preferUserTurnAnchor: true,
            visibleSourceRange,
        }),
    };
}

/**
 * The single publication point for navigation visibility. Every trigger (scroll
 * ingress, layout/content-size change, native viewability, anchor/entry change)
 * funnels through here so the store has exactly one writer.
 */
export function publishTranscriptNavigationVisibility(params: Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    itemCount: number;
    readVisibleSourceRange: () => TranscriptRendererVisibleIndexRange | null | undefined;
    store: NavigationVisibilityStore;
}>): TranscriptNavigationVisibilityWriteDecision {
    if (!params.store.hasSubscribers()) return { kind: 'skip', reason: 'no-subscribers' };
    let visibleSourceRange: TranscriptRendererVisibleIndexRange | null | undefined = null;
    try {
        visibleSourceRange = params.readVisibleSourceRange();
    } catch {
        // A detached renderer is an unmeasured frame, not an empty transcript.
        return { kind: 'skip', reason: 'unmeasured-viewport' };
    }
    const decision = resolveTranscriptNavigationVisibilityWrite({
        anchors: params.anchors,
        itemCount: params.itemCount,
        visibleSourceRange,
    });
    if (decision.kind === 'write') params.store.set(decision.snapshot);
    return decision;
}

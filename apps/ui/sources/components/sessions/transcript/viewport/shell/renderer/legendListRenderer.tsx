import * as React from 'react';
import { View, type LayoutChangeEvent, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import {
    observeTranscriptPhysicalScrollMethods,
    observeTranscriptRevealVisibility,
    recordTranscriptHeldIntentLifecycle,
    recordTranscriptScrollSample,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
    type LegendListState,
} from '@legendapp/list/react-native';

import { LayoutCommitObserver } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import {
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    captureWebTranscriptViewportAnchor,
    resolveWebTranscriptViewportAnchorAlignment,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { TranscriptExplicitJumpOperationId } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type {
    TranscriptInitialPresentationSettlementRequest,
    TranscriptRendererAtEndState,
    TranscriptRendererEntryAnchorHold,
    TranscriptRendererNativePhysicalViewportCapture,
    TranscriptRendererNativePhysicalViewportObservationRequest,
    TranscriptRendererNativePhysicalViewportObservationResult,
    TranscriptRendererVisibleSourceIndexRange,
    TranscriptViewportInputEvidence,
    TranscriptViewportMutationCause,
    TranscriptListRenderer,
    TranscriptListRendererProps,
    TranscriptListShellRef,
} from './types';

const LEGEND_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// Last-resort scalar, NOT a calibrated row height. Legend resolves a row size as
// measured -> getEstimatedItemSize (the app's measurement runtime, wired below) ->
// per-type average -> this scalar, so it only reaches rows none of those can answer.
// The number itself is known to be wrong for real content: the live reopen capture of
// 2026-07-23 measured a flat 240px scalar undercounting a real transcript by 53%
// (see measurement/estimateTranscriptRowHeightFromCache.ts). It stays below the giant
// markdown outliers on purpose — per-row measured floors, not this value, are what
// keep tall rows from collapsing.
const LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX = 240;
// Legend/browser reconciliation can replay the pre-resize DOM offset about 400ms after
// a composer resize. Keep that specific layout-settle transaction distinguishable from
// a later keyboard/user scroll; wheel/drag interactions cancel it immediately.
const LEGEND_HELD_INTENT_SETTLE_MS = 1_500;
// Keyed target identity remains available after the active polling cadence goes quiet. Fresh
// load/size/commit evidence can resume verification anywhere in this bounded window.
const LEGEND_HELD_TARGET_IDENTITY_MS = 10_000;
// Native-only fallback: how recent wheel/touch/drag evidence must be for a scroll away
// from a held tail to count as a user detach. Web consumes the canonical movement fact.
const LEGEND_USER_INPUT_DETACH_WINDOW_MS = 3_500;
// While genuine user scrolling is live (recent wheel/touch/keyboard evidence, an active drag,
// or user fling momentum), held-target residual corrections must not write at all: live S-D
// write attribution (2026-07-11) traced every scored scroll reversal to verifyLanding fighting
// active wheel input (24-96px churn "repairs" per tick, and a 4x tug-of-war re-writing the same
// target against consecutive 240px user deltas). The bounded window stays open so the same
// transaction resumes once input has been quiet for this margin.
const LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS = 250;
/**
 * Maximum gap between scroll events for an UNCLASSIFIED event to count as the
 * inertia continuation of the last classified user movement. Trackpad momentum
 * emits events every ~16-100ms; Legend replay/measurement bursts arrive after
 * longer gaps or with a correction write interleaved.
 */
const LEGEND_USER_SCROLL_INERTIA_CONTINUATION_MS = 320;
// A momentum phase counts as USER momentum only when it chains off a real drag release (or a
// previous user momentum phase, e.g. the boundary rubber-band spring) within this window.
// Momentum emitted by programmatic animated scrolls never suppresses corrections.
const LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS = 500;
// Identity host wrapper: @legendapp/list does not forward nativeID/testID to any
// rendered node (verified against the 3.3.0 dist). The web viewport ownership stack
// resolves its scroll container via document.getElementById(nativeID) and then
// descends to the scrollable, so the adapter must own the identity on a wrapper
// View that is an ancestor of the Legend scroller.
const LEGEND_IDENTITY_HOST_STYLE = { flex: 1, minHeight: 0 } as const;

type LegendHeldScrollIntent =
    | Readonly<{ kind: 'end' }>
    | Readonly<{
        entryAnchor?: TranscriptRendererEntryAnchorHold;
        identityExpiresAtMs: number;
        fallbackIndex: number;
        key: React.Key;
        kind: 'index';
        viewOffset: number;
        viewPosition: number;
    }>
    | Readonly<{
        anchor: TranscriptRendererEntryAnchorHold;
        identityExpiresAtMs: number;
        kind: 'anchor';
    }>;

type LegendHeldIntentLanding = Readonly<{
    basis: 'legend-state' | 'native-physical' | 'web-dom';
    currentOffset: number;
    residual: number;
    targetOffset: number;
    /** Viewport length backing the landing read; web-dom and estimate-basis landings report it. */
    viewportLength?: number;
    /** Misalignment before scroll-range clamping; web-dom keyed and estimate-basis landings report it. */
    rawResidual?: number;
    /**
     * TRUE when the landing was derived from Legend position estimates (web: anchor not in
     * the DOM; native: target row not mounted/measured). Estimate landings never confirm
     * and only steer within the bounded tracking range.
     */
    estimateBasis?: boolean;
    /** Physical scroll range max (content minus viewport) backing the landing read. */
    maxOffset?: number;
}>;

type LegendNativePhysicalEntryElement = Readonly<{
    measure: (
        onSuccess: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void,
    ) => void;
    measureLayout: (
        relativeToNativeNode: unknown,
        onSuccess: (x: number, y: number, width: number, height: number) => void,
        onFail?: () => void,
    ) => void;
}>;

type LegendNativePhysicalScrollHost = Readonly<{
    measure: LegendNativePhysicalEntryElement['measure'];
}>;

type LegendNativePhysicalMeasureNode = Readonly<{
    measure: LegendNativePhysicalEntryElement['measure'];
}>;

function readHeldIntentDiagnosticIdentity(intent: LegendHeldScrollIntent): Readonly<{
    intentId: string | null;
    intentKind: 'anchor' | 'end' | 'index';
}> {
    if (intent.kind === 'end') return { intentId: null, intentKind: 'end' };
    if (intent.kind === 'anchor') {
        return { intentId: intent.anchor.itemId, intentKind: 'anchor' };
    }
    return { intentId: String(intent.key), intentKind: 'index' };
}

function readEntryPlacementItemId(intent: LegendHeldScrollIntent | null): string | null {
    if (intent?.kind === 'anchor' && intent.anchor.reason === 'entry-restore') {
        return intent.anchor.itemId;
    }
    if (intent?.kind === 'index' && intent.entryAnchor?.reason === 'entry-restore') {
        return intent.entryAnchor.itemId;
    }
    return null;
}

const LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX = 1;
// A keyed web residual that exceeds the viewport is only trustworthy when two consecutive
// reads agree: during a giant cold-page commit the scroll compensation and the DOM commit can
// be observed out of sync for one frame, and acting on that single read wrote a ~19200px-stale
// offset live (DR-030 session-B write attribution, 2026-07-11). Consecutive genuine reads of
// the same landing agree within this tolerance; a transient incoherent read never repeats.
const LEGEND_HELD_INTENT_LARGE_RESIDUAL_CONFIRM_TOLERANCE_PX = 32;

// Overscroll rubber-band settlement: when the correction target already sits ON a physical
// clamp boundary and the viewport is beyond that boundary, the platform spring settles exactly
// at the target by itself. Writing "corrections" against the spring re-launches it — the S-D
// boundary vibration (violent top/bottom overscroll oscillation, 2026-07-11 user report).
function isLegendLandingSettledByPhysicalClamp(landing: LegendHeldIntentLanding): boolean {
    if (landing.targetOffset <= 0 && landing.currentOffset <= 0) return true;
    return typeof landing.maxOffset === 'number'
        && landing.targetOffset >= landing.maxOffset
        && landing.currentOffset >= landing.targetOffset;
}

function clampLegendScrollOffset(offset: number, contentLength: number, scrollLength: number): number {
    return Math.max(0, Math.min(offset, Math.max(0, contentLength - scrollLength)));
}

function resolveLegendStateHeldIntentLanding(params: Readonly<{
    index?: number;
    intent: LegendHeldScrollIntent;
    state: LegendListState;
}>): LegendHeldIntentLanding | null {
    const { intent, state } = params;
    if (
        !Number.isFinite(state.contentLength)
        || !Number.isFinite(state.scroll)
        || !Number.isFinite(state.scrollLength)
    ) {
        return null;
    }
    let targetOffset: number;
    let rawTargetOffset: number | null = null;
    let estimateBasis = false;
    if (intent.kind === 'end') {
        targetOffset = Math.max(0, state.contentLength - state.scrollLength);
    } else if (intent.kind === 'index') {
        const index = params.index;
        if (typeof index !== 'number' || index < 0) return null;
        const position = state.positionAtIndex?.(index);
        if (!Number.isFinite(position)) return null;
        const size = state.sizeAtIndex?.(index);
        // Only a MOUNTED row's position is confirmation-grade layout truth: Legend keeps
        // serving cached sizesKnown entries for unmounted rows while their positions are
        // estimate-phase cumulative sums, and mid-expansion-cascade those estimates are
        // garbage (live native S-C 2026-07-11: corrections steered into them, read
        // themselves back as "aligned", and parked the viewport hours away). Estimate-basis
        // landings never confirm and only steer within the bounded tracking range — the
        // same CASCADE-FIX bar the web-dom anchor landing already obeys.
        const startBuffered = Number.isFinite(state.startBuffered) ? state.startBuffered : state.start;
        const endBuffered = Number.isFinite(state.endBuffered) ? state.endBuffered : state.end;
        const mounted = Number.isFinite(startBuffered)
            && Number.isFinite(endBuffered)
            && index >= startBuffered
            && index <= endBuffered;
        estimateBasis = !mounted || !Number.isFinite(size);
        // An unmeasured size degrades the viewPosition term to 0 instead of aborting the
        // landing: the estimate-basis hold keeps steering toward the row and precise
        // alignment resumes once the row mounts and measures.
        const sizeForAlignment = Number.isFinite(size) ? (size as number) : 0;
        rawTargetOffset = (position as number)
            - intent.viewOffset
            - intent.viewPosition * Math.max(0, state.scrollLength - sizeForAlignment);
        targetOffset = clampLegendScrollOffset(
            rawTargetOffset,
            state.contentLength,
            state.scrollLength,
        );
    } else return null;
    return {
        basis: 'legend-state',
        currentOffset: state.scroll,
        residual: targetOffset - state.scroll,
        targetOffset,
        maxOffset: Math.max(0, state.contentLength - state.scrollLength),
        ...(estimateBasis
            ? {
                estimateBasis: true,
                rawResidual: (rawTargetOffset ?? targetOffset) - state.scroll,
                viewportLength: state.scrollLength,
            }
            : {}),
    };
}

function settleLegendScroll(
    promise: Promise<void> | undefined,
    onSettled?: () => void,
): void {
    void promise?.then(
        () => onSettled?.(),
        () => onSettled?.(),
    );
}

type PendingInitialPresentationSettlement = Readonly<{
    deadlineAtMs: number;
    request: TranscriptInitialPresentationSettlementRequest;
}>;

function toLegendData<TItem>(data: readonly TItem[], dataOrder: TranscriptListRendererProps<TItem>['frame']['dataOrder']): readonly TItem[] {
    if (dataOrder === 'newest-first') {
        return [...data].reverse();
    }
    return data;
}

function shouldProjectChronologicalIndex<TItem>(props: TranscriptListRendererProps<TItem>): boolean {
    return props.frame.dataOrder === 'newest-first';
}

function toLegendIndex(sourceIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return sourceIndex;
    return Math.max(0, dataLength - 1 - sourceIndex);
}

function toSourceIndex(legendIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return legendIndex;
    return Math.max(0, dataLength - 1 - legendIndex);
}

function toSourceViewabilityTokens<TItem, TToken extends Readonly<{ index: number; item: TItem }>>(
    tokens: readonly TToken[],
    sourceData: readonly TItem[],
    projectChronologicalIndex: boolean,
): TToken[] {
    return tokens.map((token) => {
        const sourceIndex = toSourceIndex(token.index, sourceData.length, projectChronologicalIndex);
        const sourceItem = sourceData[sourceIndex];
        return {
            ...token,
            index: sourceIndex,
            item: sourceItem === undefined ? token.item : sourceItem,
        };
    });
}

function readDataVersion(extraData: unknown): React.Key | undefined {
    return typeof extraData === 'string' || typeof extraData === 'number' ? extraData : undefined;
}

function readWheelDeltaY(event: unknown): number | null {
    if (!event || typeof event !== 'object') return null;
    const direct = (event as { deltaY?: unknown }).deltaY;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const nativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (!nativeEvent || typeof nativeEvent !== 'object') return null;
    const nested = (nativeEvent as { deltaY?: unknown }).deltaY;
    return typeof nested === 'number' && Number.isFinite(nested) ? nested : null;
}

type TouchVerticalCoordinate = Readonly<{
    axis: 'client' | 'page';
    value: number;
}>;

function readTouchVerticalCoordinate(event: unknown): TouchVerticalCoordinate | null {
    const direct = event && typeof event === 'object'
        ? event as Record<string, unknown>
        : null;
    const nativeEvent = direct?.nativeEvent && typeof direct.nativeEvent === 'object'
        ? direct.nativeEvent as Record<string, unknown>
        : null;
    const firstTouch = (value: unknown): Record<string, unknown> | null => {
        if (!value || typeof value !== 'object') return null;
        const touch = (value as { 0?: unknown })[0];
        return touch && typeof touch === 'object' ? touch as Record<string, unknown> : null;
    };
    const candidates = [
        direct,
        nativeEvent,
        firstTouch(direct?.touches),
        firstTouch(nativeEvent?.touches),
        firstTouch(direct?.changedTouches),
        firstTouch(nativeEvent?.changedTouches),
    ];
    for (const candidate of candidates) {
        const clientY = candidate?.clientY;
        if (typeof clientY === 'number' && Number.isFinite(clientY)) {
            return { axis: 'client', value: clientY };
        }
    }
    for (const candidate of candidates) {
        const pageY = candidate?.pageY;
        if (typeof pageY === 'number' && Number.isFinite(pageY)) {
            return { axis: 'page', value: pageY };
        }
    }
    return null;
}

function toLegendSlot(node: React.ReactNode): React.ReactElement | null {
    return React.isValidElement(node) ? node : null;
}

function readLegendAtEndState(state: LegendListState | undefined): TranscriptRendererAtEndState | null {
    if (!state) return null;
    return {
        isAtEnd: state.isAtEnd === true,
        isFollowing: state.isWithinMaintainScrollAtEndThreshold === true,
        isNearEnd: state.isNearEnd === true,
        isWithinMaintainScrollAtEndThreshold: state.isWithinMaintainScrollAtEndThreshold === true,
    };
}

export function resolveLegendRendererAtEndStateFromWebMetrics(params: Readonly<{
    metrics: Pick<WebTranscriptScrollMetrics, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;
    maintainScrollAtEndThreshold: number;
}>): TranscriptRendererAtEndState {
    const distanceFromBottom = Math.max(
        0,
        params.metrics.scrollHeight - params.metrics.clientHeight - params.metrics.scrollTop,
    );
    const thresholdRatio = Number.isFinite(params.maintainScrollAtEndThreshold)
        ? Math.max(0, params.maintainScrollAtEndThreshold)
        : 0;
    const thresholdPx = thresholdRatio * Math.max(0, params.metrics.clientHeight);
    return {
        isAtEnd: distanceFromBottom <= 1,
        isFollowing: distanceFromBottom <= thresholdPx,
        isNearEnd: distanceFromBottom <= thresholdPx,
        isWithinMaintainScrollAtEndThreshold: distanceFromBottom <= thresholdPx,
    };
}

function LegendListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const legendListRef = React.useRef<LegendListRef | null>(null);
    const identityHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const visualBottomSlotHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const heldScrollIntentRef = React.useRef<LegendHeldScrollIntent | null>(
        props.frame.rendererOptions.initialPlacement.atEnd ? { kind: 'end' } : null,
    );
    const nativePhysicalEntryMeasurementRef = React.useRef<Readonly<{
        element: LegendNativePhysicalEntryElement;
        generation: object;
        intent: LegendHeldScrollIntent;
        scrollHost: LegendNativePhysicalScrollHost;
    }> | null>(null);
    const nativePhysicalEntryMeasurementGenerationRef = React.useRef<object>({});
    const latestNativePhysicalViewportCaptureRef =
        React.useRef<TranscriptRendererNativePhysicalViewportCapture | null>(null);
    const nativePhysicalViewportObservationRef = React.useRef<object | null>(null);
    const explicitJumpTakeoverOperationRef = React.useRef<TranscriptExplicitJumpOperationId | null>(null);
    const [, renderPositioningPhase] = React.useReducer((revision: number) => revision + 1, 0);
    const pendingViewportCauseRef = React.useRef<TranscriptViewportMutationCause>('layout');
    const webTailDetachedIntentRef = React.useRef(false);
    const webScrollbarDragCleanupRef = React.useRef<(() => void) | null>(null);
    const lastUserInteractionAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    // SCROLL-INTENT evidence only (wheel/drag/keyboard/momentum) — a bare tap records general
    // interaction (write suppression, hold release at touch) but must NOT classify later
    // offset movement as a user detach: an expansion commit keeps moving the offset for
    // seconds after the toggling tap, and detach-releasing there strands the armed hold
    // (live native S-C re-run 2026-07-11 09:03).
    const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    // S-D user-scroll-live evidence: an active drag, user fling momentum (chained off a drag
    // release or a previous user momentum phase), or wheel/touch/keyboard input within the
    // suppression margin. While live, verifyLanding never writes residual corrections.
    const userDragActiveRef = React.useRef(false);
    const userMomentumActiveRef = React.useRef(false);
    const lastDragEndAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastUserMomentumEndAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const webTouchVerticalCoordinateRef = React.useRef<TouchVerticalCoordinate | null>(null);
    const lastViewportHeightRef = React.useRef<number | null>(null);
    const lastVisualBottomSlotHeightRef = React.useRef<number | null>(null);
    const hasCommittedVisualBottomSlotRef = React.useRef(false);
    const previousVisualBottomSlotRef = React.useRef<React.ReactNode>(null);
    const hasCommittedHeldTailDataRevisionRef = React.useRef(false);
    const lastObservedScrollOffsetRef = React.useRef<number | null>(null);
    const webScrollableElementRef = React.useRef<HTMLElement | null>(null);
    const onEntryPlacementEventRef = React.useRef(props.onEntryPlacementEvent);
    useCommittedTranscriptRef(onEntryPlacementEventRef, props.onEntryPlacementEvent);
    const activeEntryPlacementItemIdRef = React.useRef<string | null>(null);
    const finishedEntryPlacementItemIdRef = React.useRef<string | null>(null);
    const lastEntryPlacementExactAlignmentRef = React.useRef(false);
    const viewportRevealMeasurementGenerationRef = React.useRef<object | null>(null);
    const heldIntentSettleFrameRef = React.useRef<number | null>(null);
    const heldIntentSettleUntilRef = React.useRef(
        props.frame.rendererOptions.initialPlacement.atEnd
            ? Date.now() + LEGEND_HELD_INTENT_SETTLE_MS
            : 0,
    );
    const lastHeldIntentCorrectionRef = React.useRef<Readonly<{
        currentOffset: number;
        intent: LegendHeldScrollIntent;
        targetOffset: number;
        /** Offset read back right after a web-dom write (clamp-aware); null for other bases. */
        landedOffset: number | null;
    }> | null>(null);
    // Native keeps its renderer-local drag/momentum continuation because it has no DOM
    // observation owner. Web continuation belongs to the mounted WebDom observation below.
    const nativeMovementEpochRef = React.useRef(0);
    const lastClassifiedNativeUserScrollRef = React.useRef<Readonly<{
        atMs: number;
        direction: 1 | -1;
        epoch: number;
    }> | null>(null);
    const advanceMovementEpoch = React.useCallback(() => {
        nativeMovementEpochRef.current += 1;
        lastClassifiedNativeUserScrollRef.current = null;
        props.webDomObservation.invalidateUserMovementAuthority();
    }, [props.webDomObservation]);
    const invalidateUserInertiaContinuation = React.useCallback(() => {
        // A command boundary ends the prior gesture as continuation authority. Preserve live
        // drag/momentum suppression itself: an explicit command issued mid-fling must not let
        // the held corrector fight the still-active native gesture.
        advanceMovementEpoch();
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
    }, [advanceMovementEpoch]);
    const pendingLargeResidualConfirmationRef = React.useRef<Readonly<{
        intent: LegendHeldScrollIntent;
        targetOffset: number;
    }> | null>(null);
    const pendingWebTailMaterializationKeyRef = React.useRef<string | null>(null);
    // One materialization scroll EVER per tail identity: after a successful mount, the
    // measured residual owner re-mounts a flapped-out tail by scrolling — a second
    // scrollToIndex re-enters Legend's estimate-target retry machinery and closes a
    // materialize↔correct loop (live capture 2026-07-23: 255 re-fired scrollToIndex vs
    // the measured-bottom corrections, oscillating the reopened viewport for minutes).
    const completedWebTailMaterializationKeyRef = React.useRef<string | null>(null);
    const completedKeyedIdentityMaterializationRef = React.useRef(false);
    const lastPublishedAtEndStateRef = React.useRef<TranscriptRendererAtEndState | null>(null);
    const lastPublishedAtEndCauseRef = React.useRef<TranscriptViewportMutationCause | null>(null);
    const lastEmittedContentHeightRef = React.useRef<number | null>(null);
    const pendingInitialPresentationSettlementRef =
        React.useRef<PendingInitialPresentationSettlement | null>(null);
    const tryAcknowledgeInitialPresentationSettlementRef =
        React.useRef<() => boolean>(() => false);
    // While true, physically-at-end observations must NOT auto-latch a held-'end' intent:
    // a detached-anchor entry mounts over the previous session's still-at-end geometry, and an
    // auto-latch there drags the entry-anchor restore back to the tail. Cleared by real scroll
    // movement or an explicit renderer command.
    const suppressAutoEndLatchRef = React.useRef(
        !props.frame.rendererOptions.initialPlacement.atEnd,
    );
    const isWebFrame = props.frame.platform === 'web';
    // Read once per transcript (the hook shares one process-wide platform subscription) and
    // published through a committed ref so the tail command owner keeps a stable identity —
    // the imperative handle is identity-sensitive.
    const reduceMotionRef = React.useRef(false);
    useCommittedTranscriptRef(reduceMotionRef, useReducedMotionPreference());
    const finishEntryPlacement = React.useCallback((
        intent: LegendHeldScrollIntent | null,
        outcome: 'settled' | 'deadline' | 'preempted' | 'superseded' | 'unavailable',
    ) => {
        if (intent == null) return;
        const itemId = readEntryPlacementItemId(intent);
        if (itemId == null) return;
        if (activeEntryPlacementItemIdRef.current !== itemId) return;
        if (finishedEntryPlacementItemIdRef.current === itemId) return;
        finishedEntryPlacementItemIdRef.current = itemId;
        // A terminal presentation outcome is also the terminal authority boundary for this
        // entry-specific hold. Release it before notifying the presentation owner so a
        // placeholder reveal cannot be followed by a late size/layout residual write from the
        // same lifecycle. Non-entry reading/navigation holds retain their independent deadline.
        if (heldScrollIntentRef.current === intent) {
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'hold-release',
            });
            heldScrollIntentRef.current = null;
            heldIntentSettleUntilRef.current = 0;
            lastHeldIntentCorrectionRef.current = null;
            pendingLargeResidualConfirmationRef.current = null;
            pendingWebTailMaterializationKeyRef.current = null;
            completedKeyedIdentityMaterializationRef.current = false;
            const cancelAnimationFrame = globalThis.cancelAnimationFrame;
            if (typeof cancelAnimationFrame === 'function' && heldIntentSettleFrameRef.current !== null) {
                cancelAnimationFrame(heldIntentSettleFrameRef.current);
            }
            heldIntentSettleFrameRef.current = null;
        }
        onEntryPlacementEventRef.current?.({
            dataKey: props.dataKey,
            itemId,
            outcome,
            platform: props.frame.platform,
            type: 'finished',
        });
    }, [props.dataKey, props.frame.platform]);
    const startEntryPlacement = React.useCallback((intent: LegendHeldScrollIntent | null) => {
        const itemId = readEntryPlacementItemId(intent);
        if (itemId == null) return;
        if (
            activeEntryPlacementItemIdRef.current === itemId
            && finishedEntryPlacementItemIdRef.current !== itemId
        ) {
            // Index bootstrap -> exact anchor is one placement, not a successor.
            lastEntryPlacementExactAlignmentRef.current = false;
            return;
        }
        if (finishedEntryPlacementItemIdRef.current === itemId) return;
        activeEntryPlacementItemIdRef.current = itemId;
        finishedEntryPlacementItemIdRef.current = null;
        lastEntryPlacementExactAlignmentRef.current = false;
        onEntryPlacementEventRef.current?.({
            dataKey: props.dataKey,
            itemId,
            platform: props.frame.platform,
            type: 'started',
        });
    }, [props.dataKey, props.frame.platform]);

    const setHeldScrollIntent = React.useCallback((intent: LegendHeldScrollIntent | null) => {
        const previousIntent = heldScrollIntentRef.current;
        const previousEntryItemId = readEntryPlacementItemId(previousIntent);
        const nextEntryItemId = readEntryPlacementItemId(intent);
        if (previousEntryItemId != null && previousEntryItemId !== nextEntryItemId) {
            finishEntryPlacement(previousIntent, 'superseded');
        }
        if (
            previousEntryItemId == null &&
            nextEntryItemId != null &&
            finishedEntryPlacementItemIdRef.current === nextEntryItemId
        ) {
            // A cleared predecessor followed by the same persisted row is a fresh entry
            // lifecycle (for example a same-session warm reopen), not the index->anchor
            // continuation of the still-live predecessor hold.
            activeEntryPlacementItemIdRef.current = null;
            finishedEntryPlacementItemIdRef.current = null;
        }
        const previousHeldEndOwnership = previousIntent?.kind === 'end';
        const nextHeldEndOwnership = intent?.kind === 'end';
        if (previousIntent !== intent) {
            completedKeyedIdentityMaterializationRef.current = false;
            if (intent) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'hold-set',
                });
            } else if (
                previousIntent
                && heldScrollIntentRef.current === previousIntent
            ) {
                // finishEntryPlacement owns terminal entry release diagnostics and clears
                // the live ref before this generic transition continues.
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(previousIntent),
                    event: 'hold-release',
                });
            }
        }
        heldScrollIntentRef.current = intent;
        startEntryPlacement(intent);
        if (previousHeldEndOwnership !== nextHeldEndOwnership) {
            renderPositioningPhase();
        }
    }, [finishEntryPlacement, startEntryPlacement]);
    const data = React.useMemo(() => toLegendData(props.data, props.frame.dataOrder), [props.data, props.frame.dataOrder]);
    const dataLength = data.length;
    const projectChronologicalIndex = shouldProjectChronologicalIndex(props);
    const legendDataVersion = readDataVersion(props.extraData);
    const nativePhysicalViewportIdentity = React.useMemo(() => ({
        data,
        dataKey: props.dataKey,
        dataLength,
        keyExtractor: props.keyExtractor,
        projectChronologicalIndex,
        sourceData: props.data,
    }), [
        data,
        dataLength,
        projectChronologicalIndex,
        props.dataKey,
        props.data,
        props.keyExtractor,
    ]);
    const nativePhysicalViewportIdentityRef = React.useRef(nativePhysicalViewportIdentity);
    nativePhysicalViewportIdentityRef.current = nativePhysicalViewportIdentity;
    const invalidateNativePhysicalViewportCapture = React.useCallback(() => {
        latestNativePhysicalViewportCaptureRef.current = null;
        nativePhysicalViewportObservationRef.current = null;
    }, []);
    const observeNativePhysicalViewport = React.useCallback((
        request: TranscriptRendererNativePhysicalViewportObservationRequest,
    ): TranscriptRendererNativePhysicalViewportObservationResult => {
        if (isWebFrame) return { status: 'unavailable' };

        const identity = nativePhysicalViewportIdentityRef.current;
        const latest = latestNativePhysicalViewportCaptureRef.current;
        if (latest) {
            const currentItem = identity.sourceData[latest.itemIndex];
            if (
                latest.dataKey === identity.dataKey
                && currentItem !== undefined
                && identity.keyExtractor(currentItem, latest.itemIndex) === latest.itemKey
            ) {
                return { capture: latest, status: 'captured' };
            }
            invalidateNativePhysicalViewportCapture();
        }
        if (!request.onComplete) return { status: 'unavailable' };

        const legendRef = legendListRef.current;
        const state = legendRef?.getState();
        const scroller = legendRef?.getNativeScrollRef?.() as unknown as Readonly<{
            getInnerViewRef?: () => unknown;
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        const contentHost = scroller?.getInnerViewRef?.() as
            | LegendNativePhysicalMeasureNode
            | null
            | undefined;
        const scrollHost = scroller?.getNativeScrollRef?.() as
            | LegendNativePhysicalMeasureNode
            | null
            | undefined;
        const startBuffered = state?.startBuffered ?? state?.start;
        const endBuffered = state?.endBuffered ?? state?.end;
        if (
            !legendRef
            || !state
            || typeof state.elementAtIndex !== 'function'
            || typeof contentHost?.measure !== 'function'
            || typeof scrollHost?.measure !== 'function'
            || !Number.isFinite(startBuffered)
            || !Number.isFinite(endBuffered)
        ) {
            return { status: 'unavailable' };
        }

        const firstLegendIndex = Math.max(
            0,
            Math.min(identity.dataLength - 1, Math.trunc(startBuffered as number)),
        );
        const lastLegendIndex = Math.max(
            firstLegendIndex,
            Math.min(identity.dataLength - 1, Math.trunc(endBuffered as number)),
        );
        const candidates: Array<Readonly<{
            element: LegendNativePhysicalMeasureNode;
            item: TItem;
            itemKey: string;
            legendIndex: number;
            sourceIndex: number;
        }>> = [];
        for (let legendIndex = firstLegendIndex; legendIndex <= lastLegendIndex; legendIndex += 1) {
            const item = identity.data[legendIndex];
            const sourceIndex = toSourceIndex(
                legendIndex,
                identity.dataLength,
                identity.projectChronologicalIndex,
            );
            const element = state.elementAtIndex(legendIndex) as unknown as
                | LegendNativePhysicalMeasureNode
                | null
                | undefined;
            if (
                item === undefined
                || typeof element?.measure !== 'function'
                || sourceIndex < 0
                || sourceIndex >= identity.sourceData.length
            ) {
                continue;
            }
            candidates.push({
                element,
                item,
                itemKey: identity.keyExtractor(item, sourceIndex),
                legendIndex,
                sourceIndex,
            });
        }
        if (candidates.length === 0) return { status: 'unavailable' };

        const observation = {};
        nativePhysicalViewportObservationRef.current = observation;
        latestNativePhysicalViewportCaptureRef.current = null;
        let remainingMeasurements = candidates.length + 2;
        let contentMeasurement: Readonly<{ height: number; pageY: number }> | null = null;
        let hostMeasurement: Readonly<{ height: number; pageY: number }> | null = null;
        const measuredRows: Array<Readonly<{
            candidate: (typeof candidates)[number];
            height: number;
            pageY: number;
        }>> = [];
        const finishMeasurement = (): void => {
            remainingMeasurements -= 1;
            if (remainingMeasurements > 0) return;
            if (
                nativePhysicalViewportObservationRef.current !== observation
                || nativePhysicalViewportIdentityRef.current !== identity
                || legendListRef.current !== legendRef
                || contentMeasurement == null
                || hostMeasurement == null
            ) {
                return;
            }
            const currentScroller = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
                getInnerViewRef?: () => unknown;
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            if (
                currentScroller?.getInnerViewRef?.() !== contentHost
                || currentScroller?.getNativeScrollRef?.() !== scrollHost
                || !Number.isFinite(contentMeasurement.height)
                || !Number.isFinite(contentMeasurement.pageY)
                || !Number.isFinite(hostMeasurement.height)
                || !Number.isFinite(hostMeasurement.pageY)
                || hostMeasurement.height < 0
            ) {
                nativePhysicalViewportObservationRef.current = null;
                request.onComplete?.(null);
                return;
            }
            const currentState = legendRef.getState();
            const currentRows = measuredRows.filter(({ candidate, height, pageY }) => (
                currentState.elementAtIndex?.(candidate.legendIndex) === candidate.element
                && identity.data[candidate.legendIndex] === candidate.item
                && identity.sourceData[candidate.sourceIndex] === candidate.item
                && identity.keyExtractor(candidate.item, candidate.sourceIndex) === candidate.itemKey
                && Number.isFinite(height)
                && height >= 0
                && Number.isFinite(pageY)
            ));
            const focusPageY = hostMeasurement.pageY + Math.max(
                0,
                Math.min(request.focusOffsetPx, hostMeasurement.height),
            );
            let selected = currentRows.find(({ height, pageY }) => (
                pageY <= focusPageY && pageY + height >= focusPageY
            ));
            if (!selected) {
                selected = currentRows.reduce<(typeof currentRows)[number] | undefined>((nearest, row) => {
                    const distance = focusPageY < row.pageY
                        ? row.pageY - focusPageY
                        : focusPageY - (row.pageY + row.height);
                    if (!nearest) return row;
                    const nearestDistance = focusPageY < nearest.pageY
                        ? nearest.pageY - focusPageY
                        : focusPageY - (nearest.pageY + nearest.height);
                    return distance < nearestDistance ? row : nearest;
                }, undefined);
            }
            if (!selected) {
                nativePhysicalViewportObservationRef.current = null;
                request.onComplete?.(null);
                return;
            }
            const displayedOffset = hostMeasurement.pageY - contentMeasurement.pageY;
            const capture: TranscriptRendererNativePhysicalViewportCapture = {
                capturedAtMs: Date.now(),
                dataKey: identity.dataKey,
                itemIndex: selected.candidate.sourceIndex,
                itemKey: selected.candidate.itemKey,
                itemOffsetPx: selected.pageY - hostMeasurement.pageY,
                offsetY: Math.max(
                    0,
                    Math.round(
                        contentMeasurement.height
                        - hostMeasurement.height
                        - displayedOffset,
                    ),
                ),
            };
            nativePhysicalViewportObservationRef.current = null;
            latestNativePhysicalViewportCaptureRef.current = capture;
            request.onComplete?.(capture);
        };
        contentHost.measure((_x, _y, _width, height, _pageX, pageY) => {
            contentMeasurement = { height, pageY };
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, height, _pageX, pageY) => {
            hostMeasurement = { height, pageY };
            finishMeasurement();
        });
        for (const candidate of candidates) {
            candidate.element.measure((_x, _y, _width, height, _pageX, pageY) => {
                measuredRows.push({ candidate, height, pageY });
                finishMeasurement();
            });
        }
        return { status: 'pending' };
    }, [invalidateNativePhysicalViewportCapture, isWebFrame]);
    const heldTailDataRevision = dataLength === 0
        ? `0:${String(legendDataVersion ?? '')}`
        : [
            dataLength,
            props.keyExtractor(data[0], toSourceIndex(0, dataLength, projectChronologicalIndex)),
            props.keyExtractor(data[dataLength - 1], toSourceIndex(dataLength - 1, dataLength, projectChronologicalIndex)),
            legendDataVersion ?? '',
        ].join(':');
    // @legendapp/list has NO onContentSizeChange support (zero occurrences in the 3.x dist) —
    // forwarding the shell prop is a silent no-op. The session-open chain depends on the signal
    // (onContentSizeChange -> setListContentHeight -> sessionOpenLatch leaves 'awaiting-layout'
    // -> initial fill settles -> older pagination's 'fill-not-done' suspension clears), so the
    // adapter synthesizes it from Legend's own measured state: on every adapter layout commit
    // (data/extraData changes incl. prepends) and on Legend-internal item remeasures
    // (onItemSizeChanged), deduped by the last emitted size.
    const onContentSizeChangeRef = React.useRef(props.onContentSizeChange);
    // Publish before child layout callbacks, but never from an abandoned same-session render.
    useCommittedTranscriptRef(onContentSizeChangeRef, props.onContentSizeChange);
    const emitSynthesizedContentSize = React.useCallback(() => {
        const emit = onContentSizeChangeRef.current;
        if (!emit) return;
        const height = legendListRef.current?.getState().contentLength;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
        if (lastEmittedContentHeightRef.current === height) return;
        lastEmittedContentHeightRef.current = height;
        // Width is not part of Legend's public state surface and no transcript consumer reads
        // it (the shell handler is `(_, h) => ...`), so the synthesized signal reports 0.
        emit(0, height);
    }, []);

    const readWebScrollMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
        if (!isWebFrame || typeof document === 'undefined' || typeof window === 'undefined') return null;
        const nativeID = props.frame.rendererOptions.identity.nativeID;
        const directLegendNode = nativeID ? null : legendListRef.current?.getScrollableNode?.();
        const root = nativeID
            ? document.getElementById(nativeID)
            : typeof HTMLElement !== 'undefined' && directLegendNode instanceof HTMLElement
                ? directLegendNode
                : null;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollableElementRef.current,
            win: window,
            minOverflowPx: 0,
            allowRootFallback: true,
        });
        if (metrics) webScrollableElementRef.current = metrics.element;
        return metrics;
    }, [isWebFrame, props.frame.rendererOptions.identity.nativeID]);

    const readRendererAtEndObservation = React.useCallback((): Readonly<{
        state: TranscriptRendererAtEndState;
        contentScrollable: boolean;
    }> | null => {
        const metrics = readWebScrollMetrics();
        if (metrics) {
            return {
                state: resolveLegendRendererAtEndStateFromWebMetrics({
                    metrics,
                    maintainScrollAtEndThreshold: props.frame.rendererOptions.continuousFollow.endThresholdRatio,
                }),
                contentScrollable: metrics.scrollHeight > metrics.clientHeight + 1,
            };
        }
        const legendState = legendListRef.current?.getState();
        const state = readLegendAtEndState(legendState);
        if (!state) return null;
        const contentLength = legendState?.contentLength;
        const scrollLength = legendState?.scrollLength;
        return {
            state,
            contentScrollable:
                typeof contentLength === 'number' && Number.isFinite(contentLength)
                && typeof scrollLength === 'number' && Number.isFinite(scrollLength)
                    ? contentLength > scrollLength + 1
                    : true,
        };
    }, [
        props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        readWebScrollMetrics,
    ]);

    const readRendererAtEndState = React.useCallback((): TranscriptRendererAtEndState | null => {
        return readRendererAtEndObservation()?.state ?? null;
    }, [readRendererAtEndObservation]);

    // A live keyed (anchor/index) hold is the surviving pre-commit truth for the viewport; it
    // outlives Legend MVCP replay, estimate corrections, and this adapter's own residual
    // writes. Callers that opportunistically (re)capture a visible-anchor baseline must not
    // replace it from non-user movement.
    const hasLiveKeyedHeldIntent = React.useCallback((): boolean => {
        const heldIntent = heldScrollIntentRef.current;
        return heldIntent != null
            && heldIntent.kind !== 'end'
            && Date.now() <= heldIntent.identityExpiresAtMs;
    }, []);

    // Native semantic cause classification for at-end publications (S-I, 2026-07-11).
    // Web scroll-driven publications consume the exact WebDom movement fact instead.
    // The previous one-shot pending-cause consumption misattributed every flip that did not
    // land exactly on the first post-input scroll event: a Chromium smooth-scroll continuation
    // reaching the tail published 'layout' (the live-tail intent never reached sync and a
    // stale persisted detached anchor survived — S-G), a mid-drag threshold exit published
    // 'layout' (wantsPinned stayed true and the native older-load follow gate never opened —
    // S-I), and a NEVER-consumed 'user' (wheel at the clamp produces no scroll event) leaked
    // into a growth-driven follow-loss flip minutes later (false user detach during a giant
    // streaming commit — S-K). Classification is evidence-windowed instead:
    // - 'command' pending stays authoritative (one-shot, consumed by its own scroll event);
    // - a flip without physical offset movement is renderer/layout-caused geometry, never user;
    // - a flip INTO following counts as user within the full input-detach evidence window
    //   (physically reaching the tail within seconds of user scroll input IS the user's tail
    //   arrival — misattribution is harmless because it only re-affirms live-tail intent);
    // - a flip OUT of following (detach — deletes/creates persistence state) needs strict
    //   evidence: a live drag/momentum phase, the fresh one-shot 'user', or input within the
    //   tight write-suppression margin (smooth-scroll continuation of a genuine wheel detach).
    const resolveNativeAtEndPublicationCause = React.useCallback((params: Readonly<{
        isFollowing: boolean;
        offsetMoved: boolean;
        pendingCause: TranscriptViewportMutationCause;
    }>): TranscriptViewportMutationCause => {
        if (params.pendingCause === 'command') return 'command';
        if (!params.offsetMoved) return 'layout';
        const nowMs = Date.now();
        const dragOrMomentumLive = userDragActiveRef.current || userMomentumActiveRef.current;
        const scrollIntentAgeMs = nowMs - lastUserScrollIntentAtMsRef.current;
        const evidenceLive = dragOrMomentumLive || scrollIntentAgeMs <= LEGEND_USER_INPUT_DETACH_WINDOW_MS;
        if (!evidenceLive) return 'layout';
        if (params.isFollowing) return 'user';
        if (dragOrMomentumLive || params.pendingCause === 'user') return 'user';
        return scrollIntentAgeMs <= LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS ? 'user' : 'layout';
    }, []);

    const isUserScrollInputLive = React.useCallback((): boolean => {
        if (userDragActiveRef.current || userMomentumActiveRef.current) return true;
        return Date.now() - lastUserInteractionAtMsRef.current <= LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS;
    }, []);

    const emitRendererAtEndState = React.useCallback((
        context?: Readonly<{
            offsetMoved?: boolean;
            pendingCause?: TranscriptViewportMutationCause;
            webMovementFact?: WebScrollMovementFact;
        }>,
    ) => {
        const observation = readRendererAtEndObservation();
        if (!observation) return;
        const state = observation.state;
        // Native may latch held-'end' from a quiet SCROLLABLE at-end observation.
        // Web passive layout/state-listener observations never carry user authority:
        // web acquisition comes from an explicit toward-end clamp input or the canonical
        // downward movement fact in handleLegendScroll.
        // Underfilled mount
        // geometry (fresh session entry before the initial fill) is physically "at end" but
        // carries no tail intent; latching there re-created the re-entry scroll war against
        // detached entry-anchor restores (USER-REALITY-DIVERGENCE RC-4).
        // And only from QUIET input (same S-D principle the settle corrector enforces):
        // user viewport input (keyboard/wheel/drag) releases the held target BEFORE the
        // browser applies its default movement, and a still-at-end observation landing in
        // that window re-acquired the tail and snapped the viewport back over the user's
        // takeover (live AUD-002, 2026-07-12: trusted PageUp detached 277px, the settle
        // returned it to the tail ~118ms later). Explicit command latches are unaffected.
        if (
            !isWebFrame
            && state.isAtEnd
            && observation.contentScrollable
            && !suppressAutoEndLatchRef.current
            && !isUserScrollInputLive()
        ) {
            if (!hasLiveKeyedHeldIntent() && heldScrollIntentRef.current?.kind !== 'end') {
                setHeldScrollIntent({ kind: 'end' });
                webTailDetachedIntentRef.current = false;
            }
        }
        // A keyed anchor/index hold is the semantic viewport truth until the canonical
        // scroll callback classifies a genuine bottomward arrival and atomically replaces
        // it with held-'end'. Legend invokes threshold listeners before that public callback;
        // publishing following here would let lifecycle/sync adopt the tail while the
        // renderer still owns the detached keyed target. Return before touching either the
        // scroll baseline or publication baseline so the callback can classify and publish
        // the same arrival after the ownership transfer.
        if (state.isFollowing && hasLiveKeyedHeldIntent()) return;
        const webScroll = webScrollableElementRef.current?.scrollTop;
        const currentOffset = isWebFrame && typeof webScroll === 'number' && Number.isFinite(webScroll)
            ? webScroll
            : legendListRef.current?.getState().scroll;
        const offsetMoved = context?.offsetMoved ?? (
            !isWebFrame
            && lastObservedScrollOffsetRef.current !== null
            && typeof currentOffset === 'number'
            && Number.isFinite(currentOffset)
            && Math.abs(currentOffset - lastObservedScrollOffsetRef.current) >= 1
        );
        if (
            !isWebFrame
            && lastObservedScrollOffsetRef.current === null
            && typeof currentOffset === 'number'
            && Number.isFinite(currentOffset)
        ) {
            lastObservedScrollOffsetRef.current = currentOffset;
        }
        const pendingCause = context?.pendingCause ?? 'layout';
        const cause = isWebFrame
            ? context?.webMovementFact?.atEndPublicationCause
                ?? (pendingCause === 'command' ? 'command' : 'layout')
            : resolveNativeAtEndPublicationCause({
                isFollowing: state.isFollowing,
                offsetMoved,
                pendingCause,
            });
        const emit = props.onRendererAtEndChange;
        if (!emit) return;
        // Publish CHANGES only: geometry ticks (ResizeObserver, layout commits, state
        // listeners) re-observe identical facts at high frequency during streaming, and each
        // redundant publication cascaded into app/sync work (RC-1 storm).
        const lastPublished = lastPublishedAtEndStateRef.current;
        if (
            lastPublished
            && lastPublished.isAtEnd === state.isAtEnd
            && lastPublished.isNearEnd === state.isNearEnd
            && lastPublished.isWithinMaintainScrollAtEndThreshold === state.isWithinMaintainScrollAtEndThreshold
            && lastPublishedAtEndCauseRef.current === cause
        ) {
            return;
        }
        lastPublishedAtEndStateRef.current = state;
        lastPublishedAtEndCauseRef.current = cause;
        emit(state, { cause });
    }, [hasLiveKeyedHeldIntent, isUserScrollInputLive, isWebFrame, props.onRendererAtEndChange, readRendererAtEndObservation, resolveNativeAtEndPublicationCause, setHeldScrollIntent]);

    const cancelScheduledHeldIntentSettle = React.useCallback(() => {
        const cancelAnimationFrame = globalThis.cancelAnimationFrame;
        if (typeof cancelAnimationFrame === 'function' && heldIntentSettleFrameRef.current !== null) {
            cancelAnimationFrame(heldIntentSettleFrameRef.current);
        }
        heldIntentSettleFrameRef.current = null;
    }, []);

    React.useEffect(() => {
        if (!isWebFrame) return;
        const element = readWebScrollMetrics()?.element;
        if (!element) return;
        // Opt-in rare-defect probe (no-op unless happier.debug.viewportWrites=1).
        const disposePhysicalWrites = observeTranscriptPhysicalScrollMethods(element);
        const disposeRevealVisibility = observeTranscriptRevealVisibility(element);
        return () => {
            disposePhysicalWrites?.();
            disposeRevealVisibility?.();
        };
    }, [isWebFrame, readWebScrollMetrics]);

    const releaseHeldScrollIntent = React.useCallback((
        outcome: 'preempted' | 'superseded' = 'preempted',
    ) => {
        finishEntryPlacement(heldScrollIntentRef.current, outcome);
        setHeldScrollIntent(null);
        webTailDetachedIntentRef.current = true;
        heldIntentSettleUntilRef.current = 0;
        lastHeldIntentCorrectionRef.current = null;
        pendingLargeResidualConfirmationRef.current = null;
        pendingWebTailMaterializationKeyRef.current = null;
        cancelScheduledHeldIntentSettle();
        tryAcknowledgeInitialPresentationSettlementRef.current();
    }, [
        cancelScheduledHeldIntentSettle,
        finishEntryPlacement,
        setHeldScrollIntent,
    ]);
    const cancelLegendInitialScrollPreservation = React.useCallback(() => {
        legendListRef.current?.cancelInitialScrollPreservation();
    }, []);

    const resolveHeldIntentIndex = React.useCallback((intent: Extract<LegendHeldScrollIntent, { kind: 'index' }>): number => {
        const currentIndex = data.findIndex((item, index) => (
            props.keyExtractor(item, toSourceIndex(index, dataLength, projectChronologicalIndex)) === intent.key
        ));
        return currentIndex >= 0 ? currentIndex : intent.fallbackIndex;
    }, [data, dataLength, projectChronologicalIndex, props.keyExtractor]);

    const resolveAnchorHoldDataIndex = React.useCallback((itemId: string): number => {
        return data.findIndex((item, index) => (
            props.keyExtractor(item, toSourceIndex(index, dataLength, projectChronologicalIndex)) === itemId
        ));
    }, [data, dataLength, projectChronologicalIndex, props.keyExtractor]);

    const requestWebHeldEndMaterialization = React.useCallback((intent: LegendHeldScrollIntent): boolean => {
        if (!isWebFrame || intent.kind !== 'end' || dataLength === 0) return false;
        const state = legendListRef.current?.getState();
        if (!state) return false;
        const lastIndex = dataLength - 1;
        const startBuffered = Number.isFinite(state.startBuffered) ? state.startBuffered : state.start;
        const endBuffered = Number.isFinite(state.endBuffered) ? state.endBuffered : state.end;
        const tailIsMaterialized = Number.isFinite(startBuffered)
            && Number.isFinite(endBuffered)
            && lastIndex >= startBuffered
            && lastIndex <= endBuffered;
        if (tailIsMaterialized) {
            pendingWebTailMaterializationKeyRef.current = null;
            return false;
        }

        // INITIAL PLACEMENT IS THE LIBRARY'S. Legend resolves a scrollToIndex target from its
        // own position table (`positions[index]`), and an unresolved entry collapses the target
        // to offset 0. On a cold/bulk hydration that table is still empty for the tail while
        // Legend's own bootstrap is converging, so an adapter request issued in that window
        // does not approach the tail — it pins the viewport at the HEAD, and Legend's bootstrap
        // dispatch then has to teleport away from it. That pair is the measured web open
        // defect: full content height with scrollTop 0, a short hold, then a jump to the tail.
        // Withhold the request until the library can resolve the target; the settle loop is
        // already polling, and by the time Legend's bootstrap lands the tail is normally
        // materialized and no adapter write is issued at all.
        const tailPosition = state.positionAtIndex?.(lastIndex);
        if (
            lastIndex > 0
            && (typeof tailPosition !== 'number' || !Number.isFinite(tailPosition) || tailPosition <= 0)
        ) {
            return true;
        }

        // A cold bulk hydration can leave Legend's mounted range at the old head while its
        // truncated DOM is already physically at *that DOM's* bottom. scrollHeight therefore
        // cannot prove held-end settlement until the actual final data index is materialized.
        // Target the tail through Legend once; after it mounts, Legend's maintain-at-end
        // lifecycle owns final alignment. This is not an offscreen keep-alive and does not
        // widen the virtualization window for detached readers.
        const tailItem = data[lastIndex];
        if (tailItem === undefined) return true;
        const tailKey = `${dataLength}:${props.keyExtractor(
            tailItem,
            toSourceIndex(lastIndex, dataLength, projectChronologicalIndex),
        )}`;
        if (pendingWebTailMaterializationKeyRef.current === tailKey) return true;
        if (completedWebTailMaterializationKeyRef.current === tailKey) return false;
        completedWebTailMaterializationKeyRef.current = tailKey;
        pendingWebTailMaterializationKeyRef.current = tailKey;
        pendingViewportCauseRef.current = 'command';
        settleLegendScroll(legendListRef.current?.scrollToIndex({
            animated: false,
            index: lastIndex,
            viewPosition: 1,
        }), () => {
            if (pendingWebTailMaterializationKeyRef.current === tailKey) {
                pendingWebTailMaterializationKeyRef.current = null;
            }
        });
        return true;
    }, [data, dataLength, isWebFrame, projectChronologicalIndex, props.keyExtractor]);

    const requestWebKeyedIdentityMaterialization = React.useCallback((
        intent: LegendHeldScrollIntent,
        onSettled: () => void,
    ): boolean => {
        if (!isWebFrame || intent.kind === 'end' || completedKeyedIdentityMaterializationRef.current) {
            return false;
        }
        const index = intent.kind === 'anchor'
            ? resolveAnchorHoldDataIndex(intent.anchor.itemId)
            : resolveHeldIntentIndex(intent);
        if (index < 0 || index >= dataLength) return false;
        // One materialization request belongs to this held identity transaction. Estimated
        // geometry is not written; after the row mounts, the existing DOM-truth path corrects
        // the exact within-row offset.
        completedKeyedIdentityMaterializationRef.current = true;
        pendingViewportCauseRef.current = 'command';
        recordTranscriptHeldIntentLifecycle({
            ...readHeldIntentDiagnosticIdentity(intent),
            event: 'materialization-start',
        });
        settleLegendScroll(legendListRef.current?.scrollToIndex({
            animated: false,
            index,
            viewPosition: 0,
        }), () => {
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'materialization-settled',
            });
            onSettled();
        });
        return true;
    }, [
        dataLength,
        isWebFrame,
        resolveAnchorHoldDataIndex,
        resolveHeldIntentIndex,
    ]);

    const readHeldIntentLanding = React.useCallback((intent: LegendHeldScrollIntent): LegendHeldIntentLanding | null => {
        if (intent.kind === 'anchor') {
            const metrics = readWebScrollMetrics();
            if (!metrics) return null;
            const alignment = resolveWebTranscriptViewportAnchorAlignment({
                container: metrics.element,
                anchor: intent.anchor,
                tolerancePx: LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX - 1,
            });
            if (alignment.status === 'not_found') {
                // The anchor identity can leave the mounted window mid-transaction: a giant
                // cold/estimate collapse clamps the scroller faster than measurement signals
                // re-verify, and a DOM-only landing then reports not_found forever (live
                // A->B->A: the restored row was lost near the tail). While the identity is
                // still in renderer data, degrade to Legend's estimated data position so the
                // hold keeps steering toward the row; the DOM alignment above resumes precise
                // ownership as soon as the row mounts again.
                const dataIndex = resolveAnchorHoldDataIndex(intent.anchor.itemId);
                if (dataIndex < 0) return null;
                const position = legendListRef.current?.getState()?.positionAtIndex?.(dataIndex);
                if (typeof position !== 'number' || !Number.isFinite(position)) return null;
                const rawTarget = position - intent.anchor.itemOffsetPx;
                const targetOffset = clampLegendScrollOffset(rawTarget, metrics.scrollHeight, metrics.clientHeight);
                return {
                    basis: 'web-dom',
                    currentOffset: metrics.scrollTop,
                    residual: targetOffset - metrics.scrollTop,
                    targetOffset,
                    viewportLength: metrics.clientHeight,
                    rawResidual: rawTarget - metrics.scrollTop,
                    estimateBasis: true,
                    maxOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
                };
            }
            const targetOffset = clampLegendScrollOffset(
                metrics.scrollTop + alignment.deltaPx,
                metrics.scrollHeight,
                metrics.clientHeight,
            );
            return {
                basis: 'web-dom',
                currentOffset: metrics.scrollTop,
                residual: targetOffset - metrics.scrollTop,
                targetOffset,
                viewportLength: metrics.clientHeight,
                rawResidual: alignment.deltaPx,
                maxOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
            };
        }
        const state = legendListRef.current?.getState();
        if (!state) return null;
        const index = intent.kind === 'index' ? resolveHeldIntentIndex(intent) : undefined;
        const stateLanding = resolveLegendStateHeldIntentLanding({ index, intent, state });
        if (intent.kind === 'end') return stateLanding;
        const metrics = readWebScrollMetrics();
        if (!metrics) return stateLanding;
        const element = state.elementAtIndex?.(index ?? -1) as unknown as HTMLElement | null | undefined;
        if (!element || typeof element.getBoundingClientRect !== 'function') return stateLanding;
        const elementRect = element.getBoundingClientRect();
        const scrollerRect = metrics.element.getBoundingClientRect();
        const itemSize = elementRect.height;
        const desiredTop = intent.viewOffset
            + intent.viewPosition * Math.max(0, metrics.clientHeight - itemSize);
        const residual = elementRect.top - scrollerRect.top - desiredTop;
        const targetOffset = Math.max(
            0,
            Math.min(metrics.scrollTop + residual, Math.max(0, metrics.scrollHeight - metrics.clientHeight)),
        );
        return {
            basis: 'web-dom',
            currentOffset: metrics.scrollTop,
            residual: targetOffset - metrics.scrollTop,
            targetOffset,
            viewportLength: metrics.clientHeight,
            rawResidual: residual,
            maxOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
        };
    }, [readWebScrollMetrics, resolveAnchorHoldDataIndex, resolveHeldIntentIndex]);

    const tryAcknowledgeInitialPresentationSettlement = React.useCallback((): boolean => {
        const pending = pendingInitialPresentationSettlementRef.current;
        const request = pending?.request;
        if (!request || request.dataKey !== props.dataKey || !isWebFrame) return false;
        const heldIntent = heldScrollIntentRef.current;
        if (heldIntent?.kind === 'end') {
            const state = legendListRef.current?.getState();
            const metrics = readWebScrollMetrics();
            if (!state || !metrics || dataLength <= 0) return false;
            const lastIndex = dataLength - 1;
            const startBuffered = Number.isFinite(state.startBuffered) ? state.startBuffered : state.start;
            const endBuffered = Number.isFinite(state.endBuffered) ? state.endBuffered : state.end;
            const tailMaterialized =
                Number.isFinite(startBuffered) &&
                Number.isFinite(endBuffered) &&
                lastIndex >= startBuffered &&
                lastIndex <= endBuffered;
            const distanceFromBottom = Math.max(
                0,
                metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
            );
            if (
                !tailMaterialized
                || pendingWebTailMaterializationKeyRef.current !== null
                || (
                    distanceFromBottom > 1
                    && Date.now() < pending.deadlineAtMs
                )
            ) return false;
        } else if (heldIntent) {
            const landing = readHeldIntentLanding(heldIntent);
            const residual = landing?.basis === 'native-physical'
                ? landing.rawResidual ?? landing.residual
                : landing?.rawResidual ?? landing?.residual;
            if (
                !landing
                || landing.estimateBasis === true
                || typeof residual !== 'number'
                || Math.abs(residual) >= LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX
            ) return false;
        }
        // Held targets are confirmed against their physical landing above. With no held
        // positioning intent, no renderer alignment predicate remains to observe.
        if (pendingInitialPresentationSettlementRef.current !== pending) return false;
        pendingInitialPresentationSettlementRef.current = null;
        request.onSettled();
        return true;
    }, [
        dataLength,
        isWebFrame,
        props.dataKey,
        readHeldIntentLanding,
        readWebScrollMetrics,
    ]);
    tryAcknowledgeInitialPresentationSettlementRef.current =
        tryAcknowledgeInitialPresentationSettlement;

    const requestNativePhysicalEntryLanding = React.useCallback((
        intent: LegendHeldScrollIntent,
        generation: object,
        onLanding: (landing: LegendHeldIntentLanding) => void,
    ): boolean => {
        if (
            isWebFrame
            || intent.kind !== 'index'
            || readEntryPlacementItemId(intent) == null
        ) {
            return false;
        }
        const legendRef = legendListRef.current;
        const state = legendRef?.getState();
        if (!legendRef || !state) return false;
        const index = resolveHeldIntentIndex(intent);
        const element = state.elementAtIndex?.(index) as unknown as
            | LegendNativePhysicalEntryElement
            | null
            | undefined;
        const scrollView = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        // Legend exposes the RN ScrollView instance. Fabric measureLayout rejects the numeric
        // handle returned by ScrollView#getScrollableNode(); unwrap the native host ref instead.
        const scrollHost = scrollView?.getNativeScrollRef?.() as
            | LegendNativePhysicalScrollHost
            | null
            | undefined;
        if (
            !element
            || typeof element.measure !== 'function'
            || typeof element.measureLayout !== 'function'
            || typeof scrollHost?.measure !== 'function'
        ) {
            return false;
        }
        const inFlight = nativePhysicalEntryMeasurementRef.current;
        if (
            inFlight?.intent === intent
            && inFlight.element === element
            && inFlight.generation === generation
            && inFlight.scrollHost === scrollHost
        ) {
            return true;
        }
        // The request object is the measurement generation token. React Native does not
        // serialize measureLayout callbacks, so one row/intent request remains authoritative
        // until it completes; replacing the token also invalidates an older remounted-row read.
        const measurement = { element, generation, intent, scrollHost };
        nativePhysicalEntryMeasurementRef.current = measurement;
        let contentTop: number | null = null;
        let physicalHeight: number | null = null;
        let rowPageY: number | null = null;
        let scrollHostPageY: number | null = null;
        const abandonMeasurement = (): void => {
            if (nativePhysicalEntryMeasurementRef.current !== measurement) return;
            nativePhysicalEntryMeasurementRef.current = null;
        };
        const finishMeasurement = (): void => {
            if (
                nativePhysicalEntryMeasurementRef.current !== measurement
                || nativePhysicalEntryMeasurementGenerationRef.current !== generation
                || contentTop == null
                || physicalHeight == null
                || rowPageY == null
                || scrollHostPageY == null
            ) {
                return;
            }
            nativePhysicalEntryMeasurementRef.current = null;
            if (
                heldScrollIntentRef.current !== intent
                || Date.now() > heldIntentSettleUntilRef.current
                || Date.now() > intent.identityExpiresAtMs
            ) {
                return;
            }
            const currentLegendRef = legendListRef.current;
            const currentState = currentLegendRef?.getState();
            const currentScrollView = currentLegendRef?.getNativeScrollRef?.() as unknown as Readonly<{
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            const currentScrollHost = currentScrollView?.getNativeScrollRef?.();
            const currentIndex = resolveHeldIntentIndex(intent);
            if (
                !currentState
                || currentIndex < 0
                || currentState.elementAtIndex?.(currentIndex) !== element
                || currentScrollHost !== scrollHost
                || !Number.isFinite(currentState.contentLength)
                || !Number.isFinite(currentState.scroll)
                || !Number.isFinite(currentState.scrollLength)
                || !Number.isFinite(contentTop)
                || !Number.isFinite(physicalHeight)
                || !Number.isFinite(rowPageY)
                || !Number.isFinite(scrollHostPageY)
            ) {
                return;
            }
            const desiredTop = intent.viewOffset
                + intent.viewPosition * Math.max(0, currentState.scrollLength - physicalHeight);
            // Fabric measureLayout excludes the ScrollView content offset, so `contentTop`
            // is the content-space basis for the absolute target. Fabric `measure` includes
            // transforms; rowPageY - scrollHostPageY is therefore the natively displayed
            // row top even when Legend state believes a covered-screen write landed.
            const physicalRowTop = rowPageY - scrollHostPageY;
            const physicalScrollOffset = contentTop - physicalRowTop;
            const rawResidual = physicalRowTop - desiredTop;
            const targetOffset = clampLegendScrollOffset(
                contentTop - desiredTop,
                currentState.contentLength,
                currentState.scrollLength,
            );
            onLanding({
                basis: 'native-physical',
                currentOffset: physicalScrollOffset,
                maxOffset: Math.max(0, currentState.contentLength - currentState.scrollLength),
                rawResidual,
                residual: targetOffset - physicalScrollOffset,
                targetOffset,
                viewportLength: currentState.scrollLength,
            });
        };
        element.measureLayout(scrollHost, (_x, nextContentTop, _width, nextPhysicalHeight) => {
            contentTop = nextContentTop;
            physicalHeight = nextPhysicalHeight;
            finishMeasurement();
        }, () => {
            abandonMeasurement();
            // A detached row cannot confirm entry alignment. The existing bounded settle
            // cadence will retry after the next layout/measurement fact.
        });
        element.measure((_x, _y, _width, _height, _pageX, pageY) => {
            rowPageY = pageY;
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, _height, _pageX, pageY) => {
            scrollHostPageY = pageY;
            finishMeasurement();
        });
        return true;
    }, [isWebFrame, resolveHeldIntentIndex]);

    const writeHeldIntentResidual = React.useCallback((
        intent: LegendHeldScrollIntent,
        landing: LegendHeldIntentLanding,
    ): boolean => {
        const correctionResidual = landing.basis === 'native-physical'
            ? landing.rawResidual ?? landing.residual
            : landing.residual;
        if (Math.abs(correctionResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX) return false;
        const previous = lastHeldIntentCorrectionRef.current;
        if (previous?.intent === intent && previous.targetOffset === landing.targetOffset) {
            if (landing.basis === 'web-dom' && typeof previous.landedOffset === 'number') {
                // Web idempotence is landed-aware: if the scroller still sits where OUR last
                // write landed (possibly clamped), re-writing is a no-op loop - skip. If an
                // external writer (Legend offset replay, browser scroll anchoring) moved it
                // away from our landed offset, that is new evidence and the held keyed target
                // must re-correct.
                if (landing.currentOffset === previous.landedOffset) return false;
            } else if (
                landing.basis !== 'native-physical'
                && previous.currentOffset === landing.currentOffset
            ) {
                return false;
            }
        }
        let landedOffset: number | null = null;
        pendingViewportCauseRef.current = 'command';
        if (landing.basis === 'web-dom' && webScrollableElementRef.current) {
            const write = props.webDomObservation.recordProgrammaticScrollTopWrite({
                element: webScrollableElementRef.current,
                targetScrollTop: landing.targetOffset,
            });
            if (!write.ok) return false;
            landedOffset = write.landedScrollTop;
        } else if (isWebFrame) {
            // DOM-less adapter harness fallback only; production web always uses the canonical
            // scroller above. Keep the keyed-index write so web contract tests do not invent DOM.
            if (intent.kind === 'index') {
                settleLegendScroll(legendListRef.current?.scrollToIndex({
                    animated: false,
                    index: resolveHeldIntentIndex(intent),
                    viewOffset: intent.viewOffset,
                    viewPosition: intent.viewPosition,
                }));
            }
        } else {
            // Native keyed entry exactness is measured from the mounted row relative to the
            // physical scroller. Apply that residual through the existing offset writer;
            // never replay the estimate-based semantic command.
            settleLegendScroll(legendListRef.current?.scrollToOffset({
                animated: false,
                offset: landing.targetOffset,
            }));
        }
        lastHeldIntentCorrectionRef.current = {
            currentOffset: landing.currentOffset,
            intent,
            landedOffset,
            targetOffset: landing.targetOffset,
        };
        recordTranscriptHeldIntentLifecycle({
            ...readHeldIntentDiagnosticIdentity(intent),
            basis: landing.basis,
            currentOffset: landing.currentOffset,
            estimateBasis: landing.estimateBasis,
            event: 'residual-write',
            residual: landing.residual,
            targetOffset: landing.targetOffset,
        });
        return true;
    }, [isWebFrame, props.webDomObservation, resolveHeldIntentIndex]);

    const requestHeldIntentSettle = React.useCallback((
        options?: Readonly<{ deferFirstVerification?: boolean }>,
    ) => {
        const heldIntent = heldScrollIntentRef.current;
        if (!heldIntent) return;
        const intent: LegendHeldScrollIntent = heldIntent;
        nativePhysicalEntryMeasurementGenerationRef.current = {};
        const entryPlacementActive = readEntryPlacementItemId(intent) != null;
        const finishHeldIntentSettle = (
            outcome: 'settled' | 'deadline' | 'unavailable',
            clearHeldIntent = false,
        ): void => {
            finishEntryPlacement(intent, outcome);
            if (clearHeldIntent) setHeldScrollIntent(null);
            cancelScheduledHeldIntentSettle();
            tryAcknowledgeInitialPresentationSettlement();
        };
        if (entryPlacementActive) {
            lastEntryPlacementExactAlignmentRef.current = false;
        }
        const evaluateLanding = (landing: LegendHeldIntentLanding): boolean => {
            if (heldScrollIntentRef.current !== intent) return false;
            if (entryPlacementActive) {
                lastEntryPlacementExactAlignmentRef.current = false;
            }
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                basis: landing.basis,
                currentOffset: landing.currentOffset,
                estimateBasis: landing.estimateBasis,
                event: 'landing-read',
                residual: landing.residual,
                targetOffset: landing.targetOffset,
            });
            // A target already sitting on a physical clamp boundary with the viewport beyond
            // it is settled by the platform spring itself; corrections against the spring
            // re-launch it (S-D boundary vibration).
            if (isLegendLandingSettledByPhysicalClamp(landing)) {
                pendingLargeResidualConfirmationRef.current = null;
                const confirmationResidual = landing.basis === 'native-physical'
                    ? landing.rawResidual ?? landing.residual
                    : landing.residual;
                if (
                    entryPlacementActive
                    && landing.estimateBasis !== true
                    && Math.abs(confirmationResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX
                ) {
                    lastEntryPlacementExactAlignmentRef.current = true;
                }
                return true;
            }
            // Estimate-derived landings (web anchor not in the DOM; native row not
            // mounted/measured) are NOT confirmation-grade:
            // mid-cascade Legend estimates can be off by thousands of px, and both writing a
            // viewport-exceeding "correction" from them and going dormant on their "aligned"
            // reads parked the live viewport ~12k px from the user's content (DR-030 cascade
            // RED 2026-07-11). Keep the bounded polling window open until the DOM can measure.
            if (intent.kind !== 'end' && landing.estimateBasis === true) {
                heldIntentSettleUntilRef.current = Math.min(
                    intent.identityExpiresAtMs,
                    Date.now() + LEGEND_HELD_INTENT_SETTLE_MS,
                );
                const withinTrackingRange = typeof landing.viewportLength === 'number'
                    && landing.viewportLength > 0
                    && Math.abs(landing.rawResidual ?? landing.residual) < landing.viewportLength;
                if (!withinTrackingRange) {
                    requestWebKeyedIdentityMaterialization(intent, resumeHeldIntentSettle);
                    return false;
                }
                if (Math.abs(landing.residual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX) return false;
                writeHeldIntentResidual(intent, landing);
                return false;
            }
            const confirmationResidual = landing.basis === 'native-physical'
                ? landing.rawResidual ?? landing.residual
                : landing.residual;
            const aligned = Math.abs(confirmationResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX;
            if (aligned) {
                pendingLargeResidualConfirmationRef.current = null;
                if (entryPlacementActive && landing.estimateBasis !== true) {
                    lastEntryPlacementExactAlignmentRef.current = true;
                }
                return true;
            }
            // Keyed web residuals beyond the viewport act only on two agreeing consecutive
            // reads: a single read can observe scroll compensation and the DOM commit out of
            // sync during a giant cold-page commit, and writing from it clobbers the
            // compensation with a stale offset (live DR-030 write attribution).
            const requiresConfirmation = intent.kind !== 'end'
                && landing.basis === 'web-dom'
                && typeof landing.viewportLength === 'number'
                && landing.viewportLength > 0
                && Math.abs(landing.rawResidual ?? landing.residual) >= landing.viewportLength;
            if (requiresConfirmation) {
                const pending = pendingLargeResidualConfirmationRef.current;
                const confirmed = pending != null
                    && pending.intent === intent
                    && Math.abs(pending.targetOffset - landing.targetOffset)
                        <= LEGEND_HELD_INTENT_LARGE_RESIDUAL_CONFIRM_TOLERANCE_PX;
                if (!confirmed) {
                    pendingLargeResidualConfirmationRef.current = { intent, targetOffset: landing.targetOffset };
                    return false;
                }
            }
            pendingLargeResidualConfirmationRef.current = null;
            writeHeldIntentResidual(intent, landing);
            return false;
        };
        const verifyLanding = (): boolean => {
            const currentIntent = heldScrollIntentRef.current;
            if (currentIntent !== intent) return false;
            // Live user scrolling fully suppresses correction writes (S-D vibration): the
            // corrector otherwise fights the user's own deltas frame by frame. Keep the
            // bounded window open so the same transaction resumes once input quiets.
            if (isUserScrollInputLive()) {
                heldIntentSettleUntilRef.current = intent.kind === 'end'
                    ? Date.now() + LEGEND_HELD_INTENT_SETTLE_MS
                    : Math.min(intent.identityExpiresAtMs, Date.now() + LEGEND_HELD_INTENT_SETTLE_MS);
                return false;
            }
            if (requestWebHeldEndMaterialization(intent)) return false;
            if (intent.kind === 'end') {
                if (isWebFrame) {
                    // After the one-shot final-row materialization above, Legend's semantic
                    // maintain-at-end lifecycle is the sole steady web positioning owner.
                    // Its public isAtEnd fact can remain cached while a row remeasurement has
                    // already changed DOM geometry, so DOM residual is not a settled-gap signal.
                    pendingLargeResidualConfirmationRef.current = null;
                    return true;
                }
                if (
                    legendListRef.current?.getState()?.isWithinMaintainScrollAtEndThreshold
                    === true
                ) {
                    // Stock Legend owns native item/footer/layout/data maintenance while this
                    // fact is true. The app residual is only the beyond-threshold fallback.
                    pendingLargeResidualConfirmationRef.current = null;
                    return true;
                }
            }
            if (
                entryPlacementActive
                && requestNativePhysicalEntryLanding(
                    intent,
                    nativePhysicalEntryMeasurementGenerationRef.current,
                    (landing) => {
                        if (heldScrollIntentRef.current !== intent || isUserScrollInputLive()) return;
                        evaluateLanding(landing);
                    },
                )
            ) {
                return false;
            }
            const landing = readHeldIntentLanding(intent);
            if (!landing) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'landing-missing',
                });
                return false;
            }
            if (entryPlacementActive && !isWebFrame && intent.kind === 'index') {
                // State geometry remains the approach basis while the row/scroller cannot be
                // physically measured, but it can never confirm an entry-tagged native hold.
                return evaluateLanding({
                    ...landing,
                    estimateBasis: true,
                    rawResidual: landing.rawResidual ?? landing.residual,
                    viewportLength: landing.viewportLength
                        ?? legendListRef.current?.getState()?.scrollLength,
                });
            }
            return evaluateLanding(landing);
        };

        const monitorHeldIntentThroughLayoutSettle = (): void => {
            heldIntentSettleFrameRef.current = null;
            if (heldScrollIntentRef.current !== intent) return;
            if (Date.now() > heldIntentSettleUntilRef.current) {
                finishHeldIntentSettle(
                    lastEntryPlacementExactAlignmentRef.current ? 'settled' : 'deadline',
                );
                return;
            }
            verifyLanding();
            tryAcknowledgeInitialPresentationSettlement();
            const requestAnimationFrame = globalThis.requestAnimationFrame;
            if (typeof requestAnimationFrame !== 'function') {
                finishHeldIntentSettle('unavailable');
                return;
            }
            heldIntentSettleFrameRef.current = requestAnimationFrame(monitorHeldIntentThroughLayoutSettle);
        };

        function resumeHeldIntentSettle(deferFirstVerification = false): void {
            if (heldScrollIntentRef.current !== intent) return;
            const nowMs = Date.now();
            if (intent.kind !== 'end' && nowMs > intent.identityExpiresAtMs) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'identity-expired',
                });
                finishHeldIntentSettle('deadline', true);
                return;
            }
            // Every fresh measurement/layout/materialization signal opens one bounded active
            // polling window. Keyed identity outlives quiet polling so later evidence can
            // resume it, but never beyond the shared absolute identity deadline.
            heldIntentSettleUntilRef.current = intent.kind === 'end'
                ? nowMs + LEGEND_HELD_INTENT_SETTLE_MS
                : Math.min(intent.identityExpiresAtMs, nowMs + LEGEND_HELD_INTENT_SETTLE_MS);
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'settle-request',
            });

            // Most settle signals arrive after their geometry commit and can verify
            // synchronously. Legend's item-size callback is different: 3.3.3 invokes it
            // before its position/MVCP recalculation, so that signal joins the already-owned
            // settle frame and reads only post-commit geometry.
            if (!deferFirstVerification) verifyLanding();
            if (heldIntentSettleFrameRef.current !== null) return;
            const requestAnimationFrame = globalThis.requestAnimationFrame;
            if (typeof requestAnimationFrame !== 'function') {
                finishHeldIntentSettle('unavailable');
                return;
            }
            heldIntentSettleFrameRef.current = requestAnimationFrame(monitorHeldIntentThroughLayoutSettle);
        }

        resumeHeldIntentSettle(options?.deferFirstVerification === true);
    }, [cancelScheduledHeldIntentSettle, finishEntryPlacement, isUserScrollInputLive, isWebFrame, readHeldIntentLanding, requestNativePhysicalEntryLanding, requestWebHeldEndMaterialization, requestWebKeyedIdentityMaterialization, setHeldScrollIntent, tryAcknowledgeInitialPresentationSettlement, writeHeldIntentResidual]);

    const installWebEntryAnchor = React.useCallback((anchor: TranscriptRendererEntryAnchorHold) => {
        if (!isWebFrame) return;
        const nowMs = Date.now();
        setHeldScrollIntent({
            anchor,
            identityExpiresAtMs: nowMs + LEGEND_HELD_TARGET_IDENTITY_MS,
            kind: 'anchor',
        });
        heldIntentSettleUntilRef.current = nowMs + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        cancelScheduledHeldIntentSettle();
        requestHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle, isWebFrame, requestHeldIntentSettle, setHeldScrollIntent]);

    const holdWebEntryAnchor = React.useCallback((anchor: TranscriptRendererEntryAnchorHold) => {
        // A completed jump/restore landing starts a new command phase. Momentum evidence from
        // the previous viewport must not authorize a later unclassified browser event.
        invalidateUserInertiaContinuation();
        installWebEntryAnchor(anchor);
    }, [installWebEntryAnchor, invalidateUserInertiaContinuation]);

    const armWebVisibleAnchorHold = React.useCallback((): boolean => {
        // Opportunistic visible-row capture is only a fallback for an unowned/detached
        // viewport. It must never replace the held tail: both the early top-threshold
        // scroll path and Legend's onStartReached callback call this primitive directly,
        // including for zero-input ScrollAdjustHandler movement. Completed jump/restore
        // commands intentionally take over through holdWebEntryAnchor -> installWebEntryAnchor.
        if (heldScrollIntentRef.current?.kind === 'end') return false;
        const metrics = readWebScrollMetrics();
        if (!metrics) return false;
        const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
        if (!anchor) return false;
        // This is a continuation of the current viewport observation (including an inertia
        // re-baseline), not a new command phase, so preserve freshly classified user evidence.
        installWebEntryAnchor(anchor);
        return true;
    }, [installWebEntryAnchor, readWebScrollMetrics]);

    const armVisibleAnchorHold = React.useCallback(() => {
        // App-initiated in-viewport height commit (tool/thinking expansion toggle): the
        // renderer owns keeping the visible row still (`localHeightChangeRestoreOwner` is
        // 'renderer' under Legend), because Legend MVCP re-anchors its mounted window across
        // the expansion item replacement (live S-C, web + native 2026-07-11). A live
        // tail-follow keeps end ownership and a live keyed hold keeps its earlier baseline.
        if (heldScrollIntentRef.current?.kind === 'end') return;
        if (hasLiveKeyedHeldIntent()) return;
        const state = legendListRef.current?.getState();
        if (state?.isWithinMaintainScrollAtEndThreshold === true) return;
        if (isWebFrame) {
            armWebVisibleAnchorHold();
            return;
        }
        if (!state) return;
        if (!Number.isFinite(state.scroll) || !Number.isFinite(state.scrollLength)) return;
        const positionAtIndex = state.positionAtIndex;
        const sizeAtIndex = state.sizeAtIndex;
        if (typeof positionAtIndex !== 'function' || typeof sizeAtIndex !== 'function') return;
        const start = Math.max(0, Math.trunc(state.start ?? 0));
        const end = Math.max(start, Math.trunc(state.end ?? start));
        for (let legendIndex = start; legendIndex <= end && legendIndex < dataLength; legendIndex += 1) {
            const rowPosition = positionAtIndex(legendIndex);
            const rowSize = sizeAtIndex(legendIndex);
            if (!Number.isFinite(rowPosition) || !Number.isFinite(rowSize)) continue;
            if (rowPosition + rowSize <= state.scroll) continue;
            const targetItem = data[legendIndex];
            if (targetItem === undefined) return;
            setHeldScrollIntent({
                identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS,
                fallbackIndex: legendIndex,
                key: props.keyExtractor(
                    targetItem,
                    toSourceIndex(legendIndex, dataLength, projectChronologicalIndex),
                ),
                kind: 'index',
                viewOffset: rowPosition - state.scroll,
                viewPosition: 0,
            });
            heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
            lastHeldIntentCorrectionRef.current = null;
            pendingLargeResidualConfirmationRef.current = null;
            cancelScheduledHeldIntentSettle();
            return;
        }
    }, [armWebVisibleAnchorHold, cancelScheduledHeldIntentSettle, data, dataLength, hasLiveKeyedHeldIntent, isWebFrame, projectChronologicalIndex, props.keyExtractor, setHeldScrollIntent]);

    // S-E route-pop desync (live native capture 2026-07-11): a scroll write issued while the
    // transcript screen was covered by a pushed route can fail to become native truth, and no
    // scroll event arrives on reveal — Legend keeps computing its mounted window for the
    // believed offset while the native view displays another, leaving a persistent blank
    // region that only the user's first swipe (the first real native event) healed. On
    // reveal, compare the transformed page positions of Legend's content and its Fabric
    // scroll host. Unlike measureLayout, `measure` includes the ScrollView content transform,
    // so hostPageY - contentPageY is the natively displayed offset. When it disagrees with
    // Legend state, replay it through Legend's own scroll command: the native write is a
    // no-op (the view is already there) and Legend re-runs its window calculation for the
    // offset the user is actually looking at.
    const revalidateViewportAfterReveal = React.useCallback(() => {
        if (isWebFrame) return;
        const legendRef = legendListRef.current;
        if (!legendRef) return;
        const scroller = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
            getInnerViewRef?: () => unknown;
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        const innerRef = scroller?.getInnerViewRef?.() as Readonly<{
            measure?: (
                onSuccess: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        }> | null | undefined;
        const scrollHost = scroller?.getNativeScrollRef?.() as Readonly<{
            measure?: (
                onSuccess: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        }> | null | undefined;
        if (
            typeof innerRef?.measure !== 'function'
            || typeof scrollHost?.measure !== 'function'
        ) {
            return;
        }
        const generation = {};
        viewportRevealMeasurementGenerationRef.current = generation;
        let contentPageY: number | null = null;
        let hostPageY: number | null = null;
        const finishMeasurement = (): void => {
            const currentScroller = legendListRef.current?.getNativeScrollRef?.() as unknown as Readonly<{
                getInnerViewRef?: () => unknown;
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            if (
                viewportRevealMeasurementGenerationRef.current !== generation
                || legendListRef.current !== legendRef
                || currentScroller?.getInnerViewRef?.() !== innerRef
                || currentScroller?.getNativeScrollRef?.() !== scrollHost
                || contentPageY == null
                || hostPageY == null
            ) {
                return;
            }
            viewportRevealMeasurementGenerationRef.current = null;
            const displayedOffset = hostPageY - contentPageY;
            if (!Number.isFinite(displayedOffset)) return;
            const state = legendListRef.current?.getState();
            const believedOffset = state?.scroll;
            if (typeof believedOffset !== 'number' || !Number.isFinite(believedOffset)) return;
            if (Math.abs(displayedOffset - believedOffset) < 1) return;
            pendingViewportCauseRef.current = 'layout';
            settleLegendScroll(legendListRef.current?.scrollToOffset({
                animated: false,
                offset: Math.max(0, displayedOffset),
            }));
            // A live held intent re-verifies against the re-observed geometry instead of
            // treating the replayed offset as an external rollback.
            requestHeldIntentSettle();
        };
        innerRef.measure((_x, _y, _width, _height, _pageX, pageY) => {
            contentPageY = pageY;
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, _height, _pageX, pageY) => {
            hostPageY = pageY;
            finishMeasurement();
        });
    }, [isWebFrame, requestHeldIntentSettle]);

    const scrollRendererToEnd = React.useCallback((params?: { animated?: boolean }) => {
        invalidateUserInertiaContinuation();
        suppressAutoEndLatchRef.current = false;
        pendingViewportCauseRef.current = 'command';
        setHeldScrollIntent({ kind: 'end' });
        webTailDetachedIntentRef.current = false;
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        pendingWebTailMaterializationKeyRef.current = null;
        cancelScheduledHeldIntentSettle();
        // This is the ONLY tail write that can arrive animated. Steady end-maintenance is
        // Legend-owned and pinned to `animated: false`, and every corrective pin-bottom
        // reaches this owner unanimated (the drivers pass `command.animated ?? false`; only
        // the discrete `jump-to-bottom` command resolves to `animated: true`). So honoring the
        // OS reduced-motion preference here makes exactly the discrete, user-initiated
        // transition instant and cannot turn a correction into motion.
        settleLegendScroll(legendListRef.current?.scrollToEnd(
            params?.animated === true && reduceMotionRef.current
                ? { ...params, animated: false }
                : params,
        ));
    }, [cancelScheduledHeldIntentSettle, invalidateUserInertiaContinuation, setHeldScrollIntent]);

    const latchHeldEndIntent = React.useCallback(() => {
        setHeldScrollIntent({ kind: 'end' });
        webTailDetachedIntentRef.current = false;
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        pendingLargeResidualConfirmationRef.current = null;
        cancelScheduledHeldIntentSettle();
        requestHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle, requestHeldIntentSettle, setHeldScrollIntent]);

    const affirmWebHeldEndFromTowardEndInput = React.useCallback((): boolean => {
        if (!isWebFrame) return false;
        const heldIntent = heldScrollIntentRef.current;
        // A keyed hold remains the explicit owner and keeps its existing takeover behavior.
        if (heldIntent !== null && heldIntent.kind !== 'end') return false;
        const metrics = readWebScrollMetrics();
        if (
            !metrics
            || resolveLegendRendererAtEndStateFromWebMetrics({
                metrics,
                maintainScrollAtEndThreshold:
                    props.frame.rendererOptions.continuousFollow.endThresholdRatio,
            }).isAtEnd !== true
        ) {
            return false;
        }
        if (heldIntent?.kind === 'end') return true;
        // At the bottom clamp no scroll event can carry a movement fact. Direct toward-end
        // input plus current exact DOM geometry is the canonical acquisition boundary for
        // this otherwise unobservable case. Cached Legend state is not authority here.
        suppressAutoEndLatchRef.current = false;
        latchHeldEndIntent();
        return true;
    }, [
        isWebFrame,
        latchHeldEndIntent,
        props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        readWebScrollMetrics,
    ]);

    React.useEffect(() => () => {
        cancelScheduledHeldIntentSettle();
        invalidateNativePhysicalViewportCapture();
    }, [cancelScheduledHeldIntentSettle, invalidateNativePhysicalViewportCapture]);

    const recordViewportHeight = React.useCallback((nextHeight: number) => {
        const previousHeight = lastViewportHeightRef.current;
        lastViewportHeightRef.current = nextHeight;
        if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 1) return;
        advanceMovementEpoch();
        requestHeldIntentSettle();
    }, [advanceMovementEpoch, requestHeldIntentSettle]);

    const recordVisualBottomSlotHeight = React.useCallback((nextHeight: number) => {
        const previousHeight = lastVisualBottomSlotHeightRef.current;
        lastVisualBottomSlotHeightRef.current = nextHeight;
        if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 1) return;
        advanceMovementEpoch();
        requestHeldIntentSettle();
    }, [advanceMovementEpoch, requestHeldIntentSettle]);

    const handleLegendLayout = React.useCallback((event: LayoutChangeEvent) => {
        invalidateNativePhysicalViewportCapture();
        props.onLayout?.(event);
        recordViewportHeight(event.nativeEvent.layout.height);
    }, [invalidateNativePhysicalViewportCapture, props.onLayout, recordViewportHeight]);

    const handleVisualBottomSlotLayout = React.useCallback((event: LayoutChangeEvent) => {
        recordVisualBottomSlotHeight(event.nativeEvent.layout.height);
    }, [recordVisualBottomSlotHeight]);

    React.useEffect(() => {
        if (!isWebFrame) return undefined;
        const ResizeObserverCtor = globalThis.ResizeObserver;
        if (typeof ResizeObserverCtor !== 'function') return undefined;
        const nativeID = props.frame.rendererOptions.identity.nativeID;
        const identityHost = (
            typeof document !== 'undefined' && nativeID
                ? document.getElementById(nativeID)
                : null
        ) ?? identityHostRef.current as unknown as Element | null;
        const visualBottomSlotHost = visualBottomSlotHostRef.current as unknown as Element | null;
        if (!identityHost && !visualBottomSlotHost) return undefined;
        const observer = new ResizeObserverCtor((entries) => {
            for (const entry of entries) {
                if (entry.target === identityHost) {
                    recordViewportHeight(entry.contentRect.height);
                }
                if (entry.target === visualBottomSlotHost) {
                    recordVisualBottomSlotHeight(entry.contentRect.height);
                }
            }
            emitRendererAtEndState();
        });
        if (identityHost) observer.observe(identityHost);
        if (visualBottomSlotHost) observer.observe(visualBottomSlotHost);
        return () => observer.disconnect();
    }, [emitRendererAtEndState, isWebFrame, props.frame.rendererOptions.identity.nativeID, recordViewportHeight, recordVisualBottomSlotHeight]);

    const handleLegendScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        invalidateNativePhysicalViewportCapture();
        const cause = pendingViewportCauseRef.current;
        const state = readRendererAtEndState();
        const webScroll = webScrollableElementRef.current?.scrollTop;
        const nextScrollOffset = isWebFrame && typeof webScroll === 'number' && Number.isFinite(webScroll)
            ? webScroll
            : event.nativeEvent.contentOffset.y;
        // Opt-in diagnostics sample (no-op unless the operator opened the channel). Native
        // has no DOM scroller to intercept, so this observed offset is its only record of
        // viewport movement.
        recordTranscriptScrollSample({
            cause: cause ?? null,
            offset: nextScrollOffset,
            platform: isWebFrame ? 'web' : 'native',
        });
        const webMovementFact: WebScrollMovementFact | undefined = (() => {
            if (!isWebFrame) return undefined;
            const metrics = readWebScrollMetrics();
            if (!metrics) {
                return {
                    atEndPublicationCause: cause === 'command' ? 'command' : 'layout',
                    direction: null,
                    downwardIntent: false,
                    isGenuineUserMovement: false,
                    movedSinceLastObservation: false,
                    upwardIntent: false,
                };
            }
            return props.webDomObservation.observeGenuineScrollMovement({
                distanceFromBottom: Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop),
                fallbackObservedScrollTop: heldScrollIntentRef.current?.kind === 'end'
                    ? Math.max(0, metrics.scrollHeight - metrics.clientHeight)
                    : null,
                isTrusted: (event.nativeEvent as NativeScrollEvent & { isTrusted?: boolean }).isTrusted === true,
                metrics,
                pinThresholdPx:
                    metrics.clientHeight * props.frame.rendererOptions.continuousFollow.endThresholdRatio,
                semanticContext: {
                    atEndNonUserCause: cause === 'command' ? 'command' : 'layout',
                    isUserInputActive: userDragActiveRef.current || userMomentumActiveRef.current,
                    nowMs: Date.now(),
                },
                sustainFrames: 2,
            });
        })();
        const previousNativeScrollOffset = isWebFrame ? null : lastObservedScrollOffsetRef.current;
        if (!isWebFrame) lastObservedScrollOffsetRef.current = nextScrollOffset;
        const nativeMovementDirection: 1 | -1 | null =
            previousNativeScrollOffset === null || nextScrollOffset === previousNativeScrollOffset
                ? null
                : nextScrollOffset > previousNativeScrollOffset ? 1 : -1;
        const lastClassifiedNative = lastClassifiedNativeUserScrollRef.current;
        const isNativeUserInertiaContinuation = !isWebFrame
            && cause !== 'user'
            && cause !== 'command'
            && nativeMovementDirection !== null
            && lastClassifiedNative !== null
            && lastClassifiedNative.epoch === nativeMovementEpochRef.current
            && lastClassifiedNative.direction === nativeMovementDirection
            && Date.now() - lastClassifiedNative.atMs <= LEGEND_USER_SCROLL_INERTIA_CONTINUATION_MS
            && lastHeldIntentCorrectionRef.current === null;
        const isNativeClassifiedUserMovement = !isWebFrame
            && (
                (cause === 'user' && nativeMovementDirection !== null)
                || isNativeUserInertiaContinuation
            );
        if (isNativeClassifiedUserMovement && nativeMovementDirection !== null) {
            lastClassifiedNativeUserScrollRef.current = {
                atMs: Date.now(),
                direction: nativeMovementDirection,
                epoch: nativeMovementEpochRef.current,
            };
        }
        const movementDirection = webMovementFact?.direction ?? nativeMovementDirection;
        const isClassifiedUserMovement =
            webMovementFact?.isGenuineUserMovement ?? isNativeClassifiedUserMovement;
        const topEdgeCaptureThresholdPx = Math.max(
            4,
            (webScrollableElementRef.current?.clientHeight ?? 0) * Math.max(0, props.onStartReachedThreshold ?? 0),
        );
        const offsetMoved =
            webMovementFact?.movedSinceLastObservation
            ?? (
                previousNativeScrollOffset !== null
                && Math.abs(previousNativeScrollOffset - nextScrollOffset) >= 1
            );
        if (offsetMoved && isClassifiedUserMovement) {
            // Only genuine USER movement clears the inherited auto-latch suppression
            // guard. Passive web acquisition is independently excluded above; keeping
            // this transition user-owned preserves the remaining native quiet-end latch
            // without granting programmatic jump/prepend/restore movement user authority.
            suppressAutoEndLatchRef.current = false;
        }
        // The settle window covers programmatic held-tail writes on BOTH platforms: their own
        // scroll events must not be classified as user detachment while the transaction runs.
        const heldIntentSettleInFlight = Date.now() <= heldIntentSettleUntilRef.current;
        const movedAwayFromTail = offsetMoved
            && state
            && !state.isAtEnd
            && !state.isNearEnd
            && !state.isWithinMaintainScrollAtEndThreshold;
        const webUserMovedAwayFromTail =
            movedAwayFromTail
            && isWebFrame
            && isClassifiedUserMovement;
        if (webUserMovedAwayFromTail) {
            // Release the PRE-MOVEMENT target before the detached capture below installs the
            // user's current rest-position baseline. Releasing after capture deletes the new
            // baseline from this same event and leaves later row remeasures unowned.
            releaseHeldScrollIntent();
        }
        if (isWebFrame && (
            webTailDetachedIntentRef.current
            || nextScrollOffset <= topEdgeCaptureThresholdPx
        )) {
            // The generic host scroll-ingress owner can start pagination before Legend emits its
            // own onStartReached callback. Refresh the renderer fallback before forwarding that
            // top-edge observation. Detached web scrolls also keep a current renderer-owned
            // baseline so appends below the viewport can repair Legend row-remeasure residuals.
            // Only USER-caused movement may re-baseline a live keyed hold: Legend MVCP replay,
            // estimate corrections, and this adapter's own residual writes emit non-user scroll
            // events during a prepend/measurement burst, and re-capturing there adopts displaced
            // geometry as the new baseline and freezes the displacement (live DR-030: the held
            // transaction settled 61px off after "correcting" to a mid-burst recapture).
            if (isClassifiedUserMovement || !hasLiveKeyedHeldIntent()) {
                armWebVisibleAnchorHold();
            }
        }
        const keyedLandingDisplacedByRenderer = isWebFrame
            && offsetMoved
            && !isClassifiedUserMovement
            && hasLiveKeyedHeldIntent();
        if (keyedLandingDisplacedByRenderer) {
            // A keyed target can be displaced to the physical end of a target-window slice
            // after its active settle cadence goes quiet. In that state the tail-derived facts
            // below are all true, so "moved away from tail" cannot wake the still-live keyed
            // owner even though DOM truth reports a residual. Legend's own non-user scroll is
            // fresh displacement evidence: resume the existing bounded transaction from it.
            requestHeldIntentSettle();
        } else if (!webUserMovedAwayFromTail && movedAwayFromTail && heldIntentSettleInFlight) {
            // Chromium can emit one final scroll-anchor correction after both the layout
            // notification and the scheduled frame retry. That correction is not a user
            // detach: the interaction wrappers below cancel the held intent first for a
            // real wheel/drag. Reassert from the same renderer-owned tail target.
            requestHeldIntentSettle();
        } else if (
            !webUserMovedAwayFromTail
            && movedAwayFromTail
            && !heldIntentSettleInFlight
        ) {
            // Native has no WebDom movement fact and retains its evidence window. Web
            // non-user movement is an external rollback and must reassert the live hold.
            if (
                !isWebFrame
                && Date.now() - lastUserScrollIntentAtMsRef.current <= LEGEND_USER_INPUT_DETACH_WINDOW_MS
            ) {
                releaseHeldScrollIntent();
            } else {
                // This is an external offset rollback (Legend's internal maintain/adjust
                // path replaying a stale basis), not a user detach. Releasing here is
                // symptom 3's terminal mechanism - the held tail must be re-asserted.
                requestHeldIntentSettle();
            }
        } else if (
            offsetMoved
            && isClassifiedUserMovement
            && movementDirection === 1
            && state?.isWithinMaintainScrollAtEndThreshold === true
            && heldScrollIntentRef.current?.kind !== 'end'
        ) {
            // A semantically classified USER movement (direct input or its bounded inertia
            // continuation) landing bottomward inside the maintain threshold
            // is a genuine return to the live tail and must re-latch the durable held
            // 'end' intent HERE, REPLACING any keyed reading-anchor hold (the detached
            // branch above re-arms one on this very event, so a keyed-hold guard would
            // make this unreachable — live report 2026-07-22: the surviving anchor hold
            // restored the old position while growth pinned the tail, a two-owner fight
            // that dropped follow a few lines after re-pinning and jiggled the viewport).
            // Passive web at-end observations cannot own this arrival. This canonical
            // downward fact does; upward movement inside the threshold stays a detach
            // start and never latches. Mirrors the jump-to-bottom replacement (scrollToEnd).
            latchHeldEndIntent();
        }
        emitRendererAtEndState({ offsetMoved, pendingCause: cause, webMovementFact });
        tryAcknowledgeInitialPresentationSettlement();
        if (webMovementFact) {
            props.onScroll?.(event, webMovementFact);
        } else {
            props.onScroll?.(event);
        }
        if (pendingViewportCauseRef.current === cause) pendingViewportCauseRef.current = 'layout';
    }, [armWebVisibleAnchorHold, emitRendererAtEndState, hasLiveKeyedHeldIntent, invalidateNativePhysicalViewportCapture, isWebFrame, latchHeldEndIntent, props.frame.rendererOptions.continuousFollow.endThresholdRatio, props.onScroll, props.onStartReachedThreshold, props.webDomObservation, readRendererAtEndState, readWebScrollMetrics, releaseHeldScrollIntent, requestHeldIntentSettle, tryAcknowledgeInitialPresentationSettlement]);

    const handleLegendWheel = React.useCallback((event: unknown) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        if (isWebFrame) {
            pendingViewportCauseRef.current = 'user';
            // A bottomward wheel while holding the tail is follow-affirming input, not a
            // detach. At the bottom clamp it produces NO scroll event and NO at-end state
            // change, so a release here would leave the tail permanently unowned (nothing
            // re-latches) and the next giant streaming commit would exceed Legend's maintain
            // threshold with no corrector (live S-K, 2026-07-11). Upward wheels and wheels
            // over a keyed hold release exactly as before.
            const deltaY = readWheelDeltaY(event);
            props.webDomObservation.recordUserScrollInput({
                direction:
                    typeof deltaY !== 'number' || deltaY === 0
                        ? null
                        : deltaY > 0 ? 1 : -1,
                nowMs: Date.now(),
            });
            const followAffirming =
                typeof deltaY === 'number'
                && deltaY > 0
                && affirmWebHeldEndFromTowardEndInput();
            if (!followAffirming) {
                cancelLegendInitialScrollPreservation();
                releaseHeldScrollIntent();
            }
        }
        props.platformInteractionProps?.onWheel?.(event);
    }, [affirmWebHeldEndFromTowardEndInput, cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.platformInteractionProps, props.webDomObservation, releaseHeldScrollIntent]);

    const handleLegendScrollBeginDrag = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        userDragActiveRef.current = true;
        if (isWebFrame) {
            props.webDomObservation.recordUserScrollInput({
                direction: null,
                nowMs: Date.now(),
            });
        }
        if (!isWebFrame) {
            // A genuine native drag is the analog of the web wheel release: it overrides
            // any held-tail intent and cancels the in-flight settle window so the user's drag
            // detaches normally. Ending the drag at the tail re-latches through the next
            // at-end observation.
            cancelLegendInitialScrollPreservation();
            releaseHeldScrollIntent();
        }
        props.onScrollBeginDrag?.(event);
    }, [cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.onScrollBeginDrag, props.webDomObservation, releaseHeldScrollIntent]);

    const handleLegendScrollEndDrag = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (userDragActiveRef.current) {
            userDragActiveRef.current = false;
            lastDragEndAtMsRef.current = Date.now();
            lastUserInteractionAtMsRef.current = Date.now();
            lastUserScrollIntentAtMsRef.current = Date.now();
        }
        props.onScrollEndDrag?.(event);
    }, [props.onScrollEndDrag]);

    const handleLegendMomentumScrollBegin = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nowMs = Date.now();
        if (
            nowMs - lastDragEndAtMsRef.current <= LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS
            || nowMs - lastUserMomentumEndAtMsRef.current <= LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS
        ) {
            userMomentumActiveRef.current = true;
        }
        props.onMomentumScrollBegin?.(event);
    }, [props.onMomentumScrollBegin]);

    const handleLegendMomentumScrollEnd = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (userMomentumActiveRef.current) {
            userMomentumActiveRef.current = false;
            lastUserMomentumEndAtMsRef.current = Date.now();
            lastUserInteractionAtMsRef.current = Date.now();
            lastUserScrollIntentAtMsRef.current = Date.now();
        }
        props.onMomentumScrollEnd?.(event);
    }, [props.onMomentumScrollEnd]);

    const handleLegendTouchStart = React.useCallback((event: unknown) => {
        if (isWebFrame) {
            webTouchVerticalCoordinateRef.current = readTouchVerticalCoordinate(event);
        } else {
            lastUserInteractionAtMsRef.current = Date.now();
        }
        props.platformInteractionProps?.onTouchStart?.(event);
    }, [isWebFrame, props.platformInteractionProps]);

    React.useLayoutEffect(() => {
        emitRendererAtEndState();
        const state = legendListRef.current?.getState();
        if (!state || typeof state.listen !== 'function') return undefined;
        const unlisten = [
            state.listen('isAtEnd', () => emitRendererAtEndState({ pendingCause: pendingViewportCauseRef.current })),
            state.listen('isNearEnd', () => emitRendererAtEndState({ pendingCause: pendingViewportCauseRef.current })),
            state.listen('isWithinMaintainScrollAtEndThreshold', () => emitRendererAtEndState({ pendingCause: pendingViewportCauseRef.current })),
        ];
        return () => {
            for (const dispose of unlisten) dispose();
        };
    }, [
        emitRendererAtEndState,
        props.onRendererAtEndChange,
    ]);

    const notifyViewportInput = React.useCallback((input: TranscriptViewportInputEvidence) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        if (isWebFrame) {
            const verticalDirection =
                input.kind === 'keyboard' || input.kind === 'touch'
                    ? input.verticalDirection
                    : undefined;
            props.webDomObservation.recordUserScrollInput({
                direction:
                    verticalDirection === 'toward-end'
                        ? 1
                        : verticalDirection === 'toward-start' ? -1 : null,
                nowMs: Date.now(),
            });
        }
        const isTowardEndInput =
            (input.kind === 'keyboard' || input.kind === 'touch')
            && input.verticalDirection === 'toward-end';
        const followAffirmingHeldEndInput =
            isTowardEndInput
            && (
                isWebFrame
                    ? affirmWebHeldEndFromTowardEndInput()
                    : heldScrollIntentRef.current?.kind === 'end'
            );
        if (!followAffirmingHeldEndInput) {
            cancelLegendInitialScrollPreservation();
            releaseHeldScrollIntent();
        }
    }, [affirmWebHeldEndFromTowardEndInput, cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.webDomObservation, releaseHeldScrollIntent]);
    const handleLegendTouchMove = React.useCallback((event: unknown) => {
        const previousCoordinate = webTouchVerticalCoordinateRef.current;
        const currentCoordinate = readTouchVerticalCoordinate(event);
        if (currentCoordinate) {
            webTouchVerticalCoordinateRef.current = currentCoordinate;
        }
        const verticalDirection = previousCoordinate
            && currentCoordinate
            && previousCoordinate.axis === currentCoordinate.axis
            && previousCoordinate.value !== currentCoordinate.value
            ? currentCoordinate.value < previousCoordinate.value
                ? 'toward-end'
                : 'toward-start'
            : undefined;
        notifyViewportInput({ kind: 'touch', verticalDirection });
        props.platformInteractionProps?.onTouchMove?.(event);
    }, [notifyViewportInput, props.platformInteractionProps]);

    const beginExplicitJumpTakeover = React.useCallback((
        operationId: TranscriptExplicitJumpOperationId,
    ): (() => void) => {
        const releaseOperation = () => {
            if (explicitJumpTakeoverOperationRef.current !== operationId) return;
            explicitJumpTakeoverOperationRef.current = null;
            renderPositioningPhase();
        };
        const alreadyActive = explicitJumpTakeoverOperationRef.current !== null;
        explicitJumpTakeoverOperationRef.current = operationId;
        cancelLegendInitialScrollPreservation();
        if (alreadyActive) return releaseOperation;
        const hadHeldEndOwnership = heldScrollIntentRef.current?.kind === 'end';
        invalidateUserInertiaContinuation();
        suppressAutoEndLatchRef.current = true;
        releaseHeldScrollIntent('superseded');
        // Releasing held-end ownership schedules the phase render. Other prior intents already
        // keep maintenance disabled, but publish the explicit takeover phase synchronously.
        if (!hadHeldEndOwnership) renderPositioningPhase();
        return releaseOperation;
    }, [cancelLegendInitialScrollPreservation, invalidateUserInertiaContinuation, releaseHeldScrollIntent]);

    const observeInitialPresentationSettlement = React.useCallback((
        request: TranscriptInitialPresentationSettlementRequest,
    ): (() => void) => {
        if (!isWebFrame || request.dataKey !== props.dataKey) return () => {};
        const pending: PendingInitialPresentationSettlement = {
            deadlineAtMs: Date.now() + LEGEND_HELD_INTENT_SETTLE_MS,
            request,
        };
        pendingInitialPresentationSettlementRef.current = pending;
        if (heldScrollIntentRef.current) {
            // Reuse the renderer's existing post-layout settle frame. Legend 3.3.3
            // reports onItemSizeChanged before it schedules maintain-at-end, so the
            // callback itself is not release-grade evidence.
            requestHeldIntentSettle({ deferFirstVerification: true });
        } else {
            cancelScheduledHeldIntentSettle();
            tryAcknowledgeInitialPresentationSettlement();
        }
        return () => {
            if (pendingInitialPresentationSettlementRef.current === pending) {
                pendingInitialPresentationSettlementRef.current = null;
            }
        };
    }, [
        cancelScheduledHeldIntentSettle,
        isWebFrame,
        props.dataKey,
        requestHeldIntentSettle,
        tryAcknowledgeInitialPresentationSettlement,
    ]);

    /**
     * Legend answers its mounted window from list state. Before that state exists
     * there is NO measurement — reporting `{0,0}` here would be indistinguishable
     * from the reader genuinely sitting on the first row, which drags the
     * navigation anchor to the top of the transcript for a frame.
     */
    const readVisibleSourceIndexRange = React.useCallback((): TranscriptRendererVisibleSourceIndexRange | null => {
        const state = legendListRef.current?.getState();
        if (!state) return null;
        // `start`/`end` are Legend's NO-BUFFER window, and it sets them to null
        // whenever its last calculation found no row intersecting the viewport —
        // the viewport parked in an allocation gap or past the measured content
        // end, which is what a target-window replace can leave behind. That is a
        // measured answer, not an unmeasured frame, and nothing recomputes it
        // without a further scroll/data/size event: treating it as "no
        // measurement" froze navigation on the pre-jump anchor with rows still
        // mounted. The buffered band comes from the same calculation and is the
        // nearest rendered content, so it answers for those frames.
        //
        // Bound: this covers Legend's cached-range recalculation, which rewrites
        // only the no-buffer window and leaves the band intact. Its FULL
        // recalculation rewrites both, and only assigns `endBuffered` once it has
        // found a no-buffer start — so a viewport intersecting no row there leaves
        // no band either and this still reports unmeasured. Verified against the
        // installed @legendapp/list 3.3.3; no live capture attributes the reported
        // incident to that state, so it is deliberately NOT answered by a guessed
        // range here.
        const start = Number.isFinite(state.start) ? state.start : state.startBuffered;
        const end = Number.isFinite(state.end) ? state.end : state.endBuffered;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        const startIndex = toSourceIndex(start, dataLength, projectChronologicalIndex);
        const endIndex = toSourceIndex(end, dataLength, projectChronologicalIndex);
        return {
            startIndex: Math.min(startIndex, endIndex),
            endIndex: Math.max(startIndex, endIndex),
        };
    }, [dataLength, projectChronologicalIndex]);

    React.useImperativeHandle(ref, (): TranscriptListShellRef<TItem> => ({
        transcriptViewportCommandSpace: 'standard',
        clearLayoutCacheOnUpdate: () => {
            // Intentional no-op. The app-side structural invalidation (expand/collapse ->
            // 'clear-layout-cache') is the FlashList-era whole-list re-stack; Legend's own
            // per-item measurement pipeline (onItemSizeChanged) absorbs row re-flow. Clearing
            // Legend's size caches here rebuilt the entire list from the 240px estimate on
            // EVERY tool toggle: the offset clamped to 0 (spuriously firing top-edge
            // pagination), the coordinate space re-based, and the viewport parked hours from
            // the user's content (live native S-C root cause, 2026-07-11).
        },
        armVisibleAnchorHold,
        beginExplicitJumpTakeover,
        notifyViewportGeometryChanged: () => {
            advanceMovementEpoch();
            requestHeldIntentSettle();
        },
        observeNativePhysicalViewport,
        observeInitialPresentationSettlement,
        revalidateViewportAfterReveal,
        notifyViewportInput,
        computeVisibleIndices: () => readVisibleSourceIndexRange() ?? { startIndex: 0, endIndex: 0 },
        readVisibleSourceIndexRange,
        getAbsoluteLastScrollOffset: () => {
            return legendListRef.current?.getState().scroll ?? 0;
        },
        getFirstVisibleIndex: () => {
            const start = legendListRef.current?.getState().start ?? 0;
            return toSourceIndex(start, dataLength, projectChronologicalIndex);
        },
        getScrollableNode: () => (
            legendListRef.current?.getScrollableNode?.()
            ?? readWebScrollMetrics()?.element
            ?? null
        ),
        getLayout: (index) => {
            const state = legendListRef.current?.getState();
            const legendIndex = toLegendIndex(index, dataLength, projectChronologicalIndex);
            const y = state?.positionAtIndex?.(legendIndex);
            const height = state?.sizeAtIndex?.(legendIndex);
            if (typeof y !== 'number' || typeof height !== 'number') return undefined;
            if (!Number.isFinite(y) || !Number.isFinite(height)) return undefined;
            return { x: 0, y, width: 0, height };
        },
        holdWebEntryAnchor,
        hasActiveEntryPlacement: () => {
            const itemId = activeEntryPlacementItemIdRef.current;
            return itemId != null
                && finishedEntryPlacementItemIdRef.current !== itemId
                && readEntryPlacementItemId(heldScrollIntentRef.current) === itemId;
        },
        releaseWebHeldIntent: () => {
            invalidateUserInertiaContinuation();
            // Mark the explicit navigation takeover before releasing the tail owner.
            // Passive web observations are independently barred from reacquiring end;
            // genuine user movement or an explicit tail command clears this shared
            // lifecycle guard.
            suppressAutoEndLatchRef.current = true;
            releaseHeldScrollIntent();
        },
        hasLiveWebHold: (target) => {
            const held = heldScrollIntentRef.current;
            if (target.kind === 'end') {
                // Held-'end' is the renderer's standing tail-ownership contract
                // (Legend maintain-at-end + verifyLanding materialization); while it
                // is live, driver tail writes are a second corrector reading a
                // different scrollHeight snapshot.
                return held?.kind === 'end';
            }
            // Item targets match ANCHOR holds only: they are armed exclusively by a
            // COMPLETED landing (jump/restore success paths), so their presence means
            // the landing owner exists. Index holds are armed by the unmounted-target
            // scrollToIndex BOOTSTRAP of the same jump — treating those as live would
            // make the jump defer to its own bootstrap and never write the landing.
            if (held?.kind !== 'anchor') return false;
            if (Date.now() > held.identityExpiresAtMs) return false;
            return held.anchor.itemId === target.itemId;
        },
        scrollToEnd: (params) => {
            invalidateNativePhysicalViewportCapture();
            scrollRendererToEnd(params);
        },
        scrollToIndex: (params) => {
            invalidateNativePhysicalViewportCapture();
            invalidateUserInertiaContinuation();
            const { context, ...legendParams } = params;
            const legendIndex = toLegendIndex(params.index, dataLength, projectChronologicalIndex);
            const targetItem = data[legendIndex];
            if (targetItem !== undefined) {
                setHeldScrollIntent({
                    ...(context?.kind === 'entry-placement'
                        ? { entryAnchor: context.anchor }
                        : {}),
                    identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS,
                    fallbackIndex: legendIndex,
                    key: props.keyExtractor(
                        targetItem,
                        toSourceIndex(legendIndex, dataLength, projectChronologicalIndex),
                    ),
                    kind: 'index',
                    viewOffset: legendParams.viewOffset ?? 0,
                    viewPosition: legendParams.viewPosition ?? 0,
                });
                if (context?.kind === 'entry-placement') {
                    // This semantic call IS the one bootstrap for the entry identity. Mark it
                    // consumed so size/layout callbacks cannot dispatch a second Legend
                    // materialization request while the same promise is pending.
                    completedKeyedIdentityMaterializationRef.current = true;
                }
                heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
                lastHeldIntentCorrectionRef.current = null;
                cancelScheduledHeldIntentSettle();
            }
            pendingViewportCauseRef.current = 'command';
            settleLegendScroll(legendListRef.current?.scrollToIndex({
                ...legendParams,
                index: legendIndex,
            }), requestHeldIntentSettle);
        },
        scrollToOffset: (params) => {
            invalidateNativePhysicalViewportCapture();
            invalidateUserInertiaContinuation();
            pendingViewportCauseRef.current = 'command';
            settleLegendScroll(legendListRef.current?.scrollToOffset(params));
        },
    }), [advanceMovementEpoch, armVisibleAnchorHold, beginExplicitJumpTakeover, cancelScheduledHeldIntentSettle, data, dataLength, holdWebEntryAnchor, invalidateNativePhysicalViewportCapture, invalidateUserInertiaContinuation, notifyViewportInput, observeInitialPresentationSettlement, observeNativePhysicalViewport, projectChronologicalIndex, props.keyExtractor, readVisibleSourceIndexRange, readWebScrollMetrics, releaseHeldScrollIntent, requestHeldIntentSettle, revalidateViewportAfterReveal, scrollRendererToEnd, setHeldScrollIntent]);

    const renderItem: LegendListProps<TItem>['renderItem'] = (info) => props.renderItem({
        item: info.item,
        index: toSourceIndex(info.index, dataLength, projectChronologicalIndex),
        separators: {
            highlight: () => undefined,
            unhighlight: () => undefined,
            updateProps: () => undefined,
        },
    });
    const handleLegendViewableItemsChanged: LegendListProps<TItem>['onViewableItemsChanged'] =
        props.onViewableItemsChanged
            ? (info) => props.onViewableItemsChanged?.({
                viewableItems: toSourceViewabilityTokens(
                    info.viewableItems,
                    props.data,
                    projectChronologicalIndex,
                ),
                changed: toSourceViewabilityTokens(
                    info.changed,
                    props.data,
                    projectChronologicalIndex,
                ),
            })
            : undefined;

    const handleLegendStartReached = React.useCallback(() => {
        // The reached-edge capture must not replace a live keyed hold either: Legend can emit
        // onStartReached from its own replay-driven scroll while a prepend burst is in flight,
        // and the existing hold carries the pre-commit baseline. The live hold's IDENTITY is
        // refreshed, though: a reader DWELLING at the top outlives the 10s identity window,
        // and the prepend this trigger is about to load would then land against an expired,
        // unenforceable hold — the viewport stays at the top edge showing the new content
        // instead of the reader's rows (live report 2026-07-23). Refreshing expiry adopts no
        // geometry, so the DR-030 mid-burst recapture hazard stays excluded.
        const held = heldScrollIntentRef.current;
        let captured: boolean;
        if (held && held.kind !== 'end') {
            heldScrollIntentRef.current = { ...held, identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS };
            captured = true;
        } else {
            captured = armWebVisibleAnchorHold();
        }
        props.onStartReached?.();
        return captured;
    }, [armWebVisibleAnchorHold, props.onStartReached]);

    const handleLegendItemSizeChanged = React.useCallback(() => {
        invalidateNativePhysicalViewportCapture();
        advanceMovementEpoch();
        emitSynthesizedContentSize();
        requestHeldIntentSettle({ deferFirstVerification: true });
    }, [advanceMovementEpoch, emitSynthesizedContentSize, invalidateNativePhysicalViewportCapture, requestHeldIntentSettle]);
    React.useLayoutEffect(() => {
        if (!hasCommittedHeldTailDataRevisionRef.current) {
            hasCommittedHeldTailDataRevisionRef.current = true;
            // The WebDom observation is mounted above keyed renderer/session shells on some
            // surfaces. A new renderer mount is therefore itself a logical movement epoch even
            // though there is no initial held target to settle.
            advanceMovementEpoch();
            return;
        }
        advanceMovementEpoch();
        requestHeldIntentSettle();
    }, [advanceMovementEpoch, heldTailDataRevision, props.data, props.dataKey, props.extraData, requestHeldIntentSettle]);
    const visualBottomSlot = toLegendSlot(projectChronologicalIndex ? props.header : props.footer);
    React.useLayoutEffect(() => {
        if (!hasCommittedVisualBottomSlotRef.current) {
            hasCommittedVisualBottomSlotRef.current = true;
            previousVisualBottomSlotRef.current = visualBottomSlot;
            return;
        }
        const changed = previousVisualBottomSlotRef.current !== visualBottomSlot;
        previousVisualBottomSlotRef.current = visualBottomSlot;
        if (changed) {
            advanceMovementEpoch();
            requestHeldIntentSettle();
        }
    }, [advanceMovementEpoch, requestHeldIntentSettle, visualBottomSlot]);
    const legendVisualBottomSlot = React.useMemo<LegendListProps<TItem>['ListFooterComponent']>(() => (
        visualBottomSlot ? (
            <View ref={visualBottomSlotHostRef} onLayout={handleVisualBottomSlotLayout}>
                {visualBottomSlot}
            </View>
        ) : null
    ), [handleVisualBottomSlotLayout, visualBottomSlot]);

    const recordUserInteraction = React.useCallback(() => {
        lastUserInteractionAtMsRef.current = Date.now();
    }, []);
    // A web scrollbar drag carries no wheel/keyboard/touch evidence — only a pointer
    // press on the scroller itself (content presses target a descendant) with its
    // offset inside the scrollbar band beyond the client box. Without classifying it,
    // the drag's scroll movement reads as an external rollback and the held tail
    // drags the user back to the bottom (live capture 2026-07-20).
    const isWebScrollbarBandPress = React.useCallback((event: unknown): boolean => {
        if (!isWebFrame) return false;
        const element = webScrollableElementRef.current;
        if (!element) return false;
        const candidate = (event as { nativeEvent?: unknown } | null)?.nativeEvent ?? event;
        const press = candidate as { offsetX?: unknown; offsetY?: unknown; target?: unknown } | null;
        if (!press || press.target !== element) return false;
        const offsetX = typeof press.offsetX === 'number' ? press.offsetX : null;
        const offsetY = typeof press.offsetY === 'number' ? press.offsetY : null;
        return (offsetX !== null && offsetX >= element.clientWidth)
            || (offsetY !== null && offsetY >= element.clientHeight);
    }, [isWebFrame]);
    const endWebScrollbarDrag = React.useCallback(() => {
        const cleanup = webScrollbarDragCleanupRef.current;
        webScrollbarDragCleanupRef.current = null;
        cleanup?.();
        if (!userDragActiveRef.current) return;
        userDragActiveRef.current = false;
        lastDragEndAtMsRef.current = Date.now();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
    }, []);
    const beginWebScrollbarDrag = React.useCallback(() => {
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        props.webDomObservation.recordUserScrollInput({
            direction: null,
            nowMs: Date.now(),
        });
        userDragActiveRef.current = true;
        cancelLegendInitialScrollPreservation();
        if (webScrollbarDragCleanupRef.current) return;
        const listenerHost = globalThis.window ?? globalThis;
        if (typeof listenerHost.addEventListener !== 'function') return;
        const onRelease = () => endWebScrollbarDrag();
        listenerHost.addEventListener('pointerup', onRelease);
        listenerHost.addEventListener('pointercancel', onRelease);
        listenerHost.addEventListener('mouseup', onRelease);
        webScrollbarDragCleanupRef.current = () => {
            listenerHost.removeEventListener('pointerup', onRelease);
            listenerHost.removeEventListener('pointercancel', onRelease);
            listenerHost.removeEventListener('mouseup', onRelease);
        };
    }, [cancelLegendInitialScrollPreservation, endWebScrollbarDrag, props.webDomObservation]);
    React.useEffect(() => () => {
        webScrollbarDragCleanupRef.current?.();
        webScrollbarDragCleanupRef.current = null;
    }, []);
    const handleLegendMouseDown = React.useCallback((event: unknown) => {
        recordUserInteraction();
        if (isWebScrollbarBandPress(event)) beginWebScrollbarDrag();
        props.platformInteractionProps?.onMouseDown?.(event);
    }, [beginWebScrollbarDrag, isWebScrollbarBandPress, props.platformInteractionProps, recordUserInteraction]);
    const handleLegendPointerDown = React.useCallback((event: unknown) => {
        recordUserInteraction();
        if (isWebScrollbarBandPress(event)) beginWebScrollbarDrag();
        props.platformInteractionProps?.onPointerDown?.(event);
    }, [beginWebScrollbarDrag, isWebScrollbarBandPress, props.platformInteractionProps, recordUserInteraction]);
    const legendPlatformInteractionProps = {
        ...props.platformInteractionProps,
        onMouseDown: isWebFrame ? handleLegendMouseDown : props.platformInteractionProps?.onMouseDown,
        onPointerDown: isWebFrame ? handleLegendPointerDown : props.platformInteractionProps?.onPointerDown,
        onTouchMove: isWebFrame ? handleLegendTouchMove : props.platformInteractionProps?.onTouchMove,
        onTouchStart: handleLegendTouchStart,
        onWheel: isWebFrame ? handleLegendWheel : props.platformInteractionProps?.onWheel,
    };
    const legendProps: LegendListProps<TItem> = {
        ...legendPlatformInteractionProps,
        style: LEGEND_LIST_STYLE,
        alignItemsAtEnd: true,
        data,
        dataKey: props.dataKey,
        dataVersion: legendDataVersion,
        estimatedItemSize: LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX,
        extraData: props.extraData,
        getItemType: props.getItemType
            ? (item, index) => {
                const type = props.getItemType?.(
                    item,
                    toSourceIndex(index, dataLength, projectChronologicalIndex),
                    props.extraData,
                );
                return typeof type === 'number' ? String(type) : type;
            }
            : undefined,
        getEstimatedItemSize: props.getEstimatedItemSize
            ? (item, index) => props.getEstimatedItemSize?.(
                item,
                toSourceIndex(index, dataLength, projectChronologicalIndex),
                props.extraData,
            )
            : undefined,
        getItemSizeVersion: props.getItemSizeVersion
            ? (item, index) => props.getItemSizeVersion?.(
                item,
                toSourceIndex(index, dataLength, projectChronologicalIndex),
                props.extraData,
            )
            : undefined,
        // Continuous tail maintenance belongs to Legend, but initial placement must respect the
        // app-owned discrete entry intent. A released/anchored entry starts away from the tail so
        // entry restore can consume its saved anchor before any at-end observation clears it.
        initialScrollAtEnd: props.frame.rendererOptions.initialPlacement.atEnd,
        keyExtractor: (item, index) => props.keyExtractor(
            item,
            toSourceIndex(index, dataLength, projectChronologicalIndex),
        ),
        keyboardDismissMode: props.frame.rendererOptions.interaction.keyboardDismissMode,
        keyboardShouldPersistTaps: props.frame.rendererOptions.interaction.keyboardShouldPersistTaps,
        // Shell header/footer are FRAME LIST-SPACE slots (FlashList semantics). On newest-first
        // frames FlashList renders inverted, so the shell `header` slot (data-start) appears at
        // the VISUAL BOTTOM — that is where callers put the composer keyboard-inset spacer and
        // hot tail. This adapter re-projects data to chronological standard space, so the slots
        // must be re-projected with it: header -> visual bottom (ListFooterComponent), footer ->
        // visual top (ListHeaderComponent). Without this, the inset spacer renders at the top and
        // the last row lays out under the floating composer (native occlusion, live-measured
        // ~130pt on 2026-07-08). Oldest-first frames already are standard space: no swap.
        ListFooterComponent: legendVisualBottomSlot,
        ListHeaderComponent: toLegendSlot(projectChronologicalIndex ? props.footer : props.header),
        // Legend evaluates `withinPhysicalThreshold || isMaintainingScrollAtEnd()` — an OR, so
        // a false predicate cannot veto maintenance while the viewport is still near the tail.
        // The outer gate is therefore the only thing that can withhold maintenance from a
        // detached reader, a keyed restore or a post-jump landing: omit maintenance entirely
        // until held-end is the live positioning owner. Inside that gate the predicate is what
        // keeps follow library-owned on BOTH platforms after a late measurement pushes the
        // viewport past the threshold; without it native fell back to the app's residual
        // corrector, which repositions a frame later (the visible send jiggle).
        maintainScrollAtEnd: explicitJumpTakeoverOperationRef.current === null
            && heldScrollIntentRef.current?.kind === 'end'
            ? {
                animated: false,
                isMaintainingScrollAtEnd: () => heldScrollIntentRef.current?.kind === 'end',
            }
            : false,
        maintainScrollAtEndThreshold: props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        maintainVisibleContentPosition: { data: true, size: true },
        onEndReached: props.onEndReached,
        onEndReachedThreshold: props.onEndReachedThreshold,
        onItemSizeChanged: handleLegendItemSizeChanged,
        onLoad: (info) => {
            emitSynthesizedContentSize();
            requestHeldIntentSettle();
            props.onLoad?.(info);
        },
        onMomentumScrollBegin: handleLegendMomentumScrollBegin,
        onMomentumScrollEnd: handleLegendMomentumScrollEnd,
        onScroll: handleLegendScroll,
        onScrollBeginDrag: handleLegendScrollBeginDrag,
        onScrollEndDrag: handleLegendScrollEndDrag,
        onStartReached: handleLegendStartReached,
        onStartReachedThreshold: props.onStartReachedThreshold,
        onViewableItemsChanged: handleLegendViewableItemsChanged,
        // Transcript rows still carry row-local transient UI state (hover/copy/fork affordances)
        // in addition to keyed host expansion state. Keep remount-on-reuse semantics until a
        // recycling-specific row-state audit proves every transient is key-safe.
        recycleItems: false,
        renderItem,
        scrollEventThrottle: props.frame.rendererOptions.interaction.scrollEventThrottle,
        viewabilityConfig: props.viewabilityConfig,
    };

    return (
        <View
            ref={identityHostRef}
            nativeID={props.frame.rendererOptions.identity.nativeID}
            onLayout={handleLegendLayout}
            testID={props.frame.rendererOptions.identity.testID}
            style={LEGEND_IDENTITY_HOST_STYLE}
        >
            {/* Layout-commit signalling for the viewport ownership stack. FlashList exposes this
                natively via its LayoutCommitObserver; Legend has no equivalent, so the adapter
                reuses the shared observer (falls back to a useLayoutEffect-per-commit shim).
                The same commit signal drives the synthesized onContentSizeChange emission. */}
            <LayoutCommitObserver
                onCommitLayoutEffect={() => {
                    invalidateNativePhysicalViewportCapture();
                    emitSynthesizedContentSize();
                    requestHeldIntentSettle();
                    props.onCommitLayoutEffect?.();
                }}
            >
                <LegendList
                    ref={legendListRef}
                    {...legendProps}
                />
            </LayoutCommitObserver>
        </View>
    );
}

const LegendListTranscriptRenderer = React.forwardRef(LegendListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const legendListRenderer: TranscriptListRenderer = {
    kind: 'legendList',
    orientation: 'standard',
    Component: LegendListTranscriptRenderer,
};

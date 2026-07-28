import {
    TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX,
} from '@/components/sessions/transcript/_constants';
import {
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import {
    createInitialOlderPaginationState,
    reduceOlderPagination,
    shouldLoadNow,
    type OlderPaginationScrollTrigger,
    type OlderPaginationState,
} from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import {
    getWebTranscriptDistanceFromBottom,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { createNativeInvertedFlashListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeInvertedFlashListFacts';
import type {
    TranscriptViewportFactSource,
    TranscriptViewportObservedOffset,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportFacts';
import {
    type WebDomOlderLoadObservationTrigger,
} from '@/components/sessions/transcript/viewport/driver/webDomOlderLoadObservation';
import {
    applySidechainInitialBottomPinRequest,
    type SidechainInitialBottomPinSkipReason,
} from '@/components/sessions/transcript/viewport/shell/sidechainInitialBottomPin';
import {
    applySidechainJumpToMessageRequest,
    SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS,
} from '@/components/sessions/transcript/viewport/shell/sidechainJumpToMessage';
import {
    resolveReadOnlyTranscriptListShellFrame,
    resolveSidechainTranscriptListShellFrame,
    type TranscriptListShellCapability,
    type TranscriptListShellReadOnlyCapability,
    type TranscriptListShellFrame,
} from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import type {
    TranscriptListRendererKind,
} from '@/components/sessions/transcript/viewport/shell/renderer/types';
import {
    applySidechainOlderLoadObservation,
    resolveSidechainOlderLoadEdgeReachedObservation,
    resolveSidechainOlderLoadScrollEventObservation,
    type SidechainOlderLoadObservationInput,
} from '@/components/sessions/transcript/viewport/shell/sidechainOlderLoadObservation';
import {
    applySidechainOlderPageLoad,
    applySidechainPaginationOlderPageLoad,
    type SidechainOlderPageLoadResult,
} from '@/components/sessions/transcript/viewport/shell/sidechainOlderPageLoad';
import {
    applySidechainWebPrependGrowthRestore,
} from '@/components/sessions/transcript/viewport/shell/sidechainWebPrependGrowthRestore';

export type SidechainShellRuntimeItem = Readonly<{
    id: string;
    heightPx: number;
    ownsMessageIds: readonly string[];
    containsMessageIds: readonly string[];
}>;

export type SidechainShellRuntimeModelOptions = Readonly<{
    estimatedItemSizePx: number;
    footerHeightPx: number;
    initialScrollTopPx?: number;
    items: readonly SidechainShellRuntimeItem[];
    layoutHeightPx: number;
    platformOS: string;
}>;

export const SIDECHAIN_SHELL_JUMP_MAX_OLDER_LOAD_ATTEMPTS = SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS;

export type SidechainInitialBottomPinResult =
    | Readonly<{ ok: false; reason: 'already_applied' | 'empty' | 'jump_target' | 'local_interaction' | 'not_ready' }>
    | Readonly<{
        ok: true;
        method: 'estimated-offset-fallback' | 'scroll-to-index';
        targetIndex: number;
        targetIsFooter: false;
        targetItemId: string;
        targetScrollTop: number;
    }>;

export type SidechainJumpToMessageResult =
    | Readonly<{ ok: false; loadedPages: number; reason: 'not_found' }>
    | Readonly<{
        ok: true;
        alignment: 'center';
        loadedPages: number;
        targetIndex: number;
        targetItemId: string;
        targetScrollTop: number;
    }>;

export type SidechainOlderLoadObservation = Readonly<{
    loadCount: number;
    phase: OlderPaginationState['phase'];
    shouldLoad: boolean;
}>;

type WebLocalHeightMode = 'follow-bottom' | 'preserve-position';

type RuntimeElement = {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
};

function normalizeNonNegative(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(value, max));
}

function mapSidechainInitialBottomPinSkipReason(
    reason: SidechainInitialBottomPinSkipReason,
): Exclude<SidechainInitialBottomPinResult, Readonly<{ ok: true }>>['reason'] {
    switch (reason) {
        case 'already-applied':
            return 'already_applied';
        case 'jump-target':
            return 'jump_target';
        case 'local-interaction':
            return 'local_interaction';
        case 'empty':
            return 'empty';
        case 'not-ready':
            return 'not_ready';
    }
}

export class SidechainShellRuntimeModel {
    private items: SidechainShellRuntimeItem[];
    private readonly estimatedItemSizePx: number;
    private readonly footerHeightPx: number;
    private readonly layoutHeightPx: number;
    private readonly platformOS: string;
    private layoutReady = false;
    private contentReady = false;
    private initialBottomPinAlreadyApplied = false;
    private initialBottomPinDeferredForLocalInteraction = false;
    private loadCount = 0;
    private olderState: OlderPaginationState = createInitialOlderPaginationState();
    private readonly observation = createWebDomScrollObservation();
    private readonly element: RuntimeElement;
    private readonly rendererKind: TranscriptListRendererKind;
    private readonly shellFrame: TranscriptListShellFrame;
    private readonly nativeFactSource: TranscriptViewportFactSource;

    constructor(options: SidechainShellRuntimeModelOptions) {
        this.items = [...options.items];
        this.estimatedItemSizePx = options.estimatedItemSizePx;
        this.footerHeightPx = options.footerHeightPx;
        this.layoutHeightPx = options.layoutHeightPx;
        this.platformOS = options.platformOS;
        this.rendererKind = 'flashList';
        this.shellFrame = resolveSidechainTranscriptListShellFrame({
            platformOS: options.platformOS,
            rendererKind: this.rendererKind,
        });
        this.element = {
            clientHeight: options.layoutHeightPx,
            scrollHeight: this.contentHeightPx(),
            scrollTop: normalizeNonNegative(options.initialScrollTopPx ?? 0),
        };
        this.element.scrollTop = this.clampScrollTop(this.element.scrollTop);
        this.nativeFactSource = createNativeInvertedFlashListFactSource({
            readRawScrollOffset: () => this.element.scrollTop,
            readContentHeight: () => this.contentReady ? this.element.scrollHeight : 0,
            readLayoutHeight: () => this.layoutReady ? this.element.clientHeight : 0,
            readRenderedItemCount: () => this.items.length,
        });
    }

    commitLayout(): void {
        this.layoutReady = true;
    }

    commitContent(): void {
        this.contentReady = true;
        this.syncScrollHeight();
    }

    deferInitialBottomPinForLocalInteraction(): void {
        this.initialBottomPinDeferredForLocalInteraction = true;
    }

    observeCapability(): Readonly<{
        boundedHydration: boolean;
        catchUpIndicator: boolean;
        composerVisible: boolean;
        initialBottomPin: boolean;
        jumpToMessage: boolean;
        localHeightChangeRestore: boolean;
        nativeOlderLoadEdgeRead: boolean;
        olderPagination: boolean;
        prependGrowthRestore: boolean;
        readOnlyForkContext: boolean;
        renderer: TranscriptListRendererKind;
        scrollEventThrottle: number;
        streamingFollow: boolean;
        webOlderLoadObservation: boolean;
    }> {
        const capability = this.sidechainCapability();
        return {
            boundedHydration: capability.boundedHydration.kind === 'sidechain',
            catchUpIndicator: capability.catchUpIndicator,
            composerVisible: capability.composerVisible,
            initialBottomPin: capability.initialBottomPin,
            jumpToMessage: capability.jumpToMessage,
            localHeightChangeRestore: capability.localHeightChangeRestore,
            nativeOlderLoadEdgeRead: capability.nativeOlderLoadEdgeRead,
            olderPagination: capability.olderPagination,
            prependGrowthRestore: capability.prependGrowthRestore,
            readOnlyForkContext: capability.readOnlyForkContext,
            renderer: this.rendererKind,
            scrollEventThrottle: this.shellFrame.rendererOptions.interaction.scrollEventThrottle,
            streamingFollow: capability.streamingFollow != null,
            webOlderLoadObservation: capability.webOlderLoadObservation,
        };
    }

    requestInitialBottomPin(
        options: Readonly<{ simulateScrollToIndexFailure?: boolean }> = {},
    ): SidechainInitialBottomPinResult {
        const result = applySidechainInitialBottomPinRequest({
            alreadyApplied: this.initialBottomPinAlreadyApplied,
            contentHeightPx: this.contentReady ? this.element.scrollHeight : 0,
            dataOrder: this.shellFrame.dataOrder,
            deferredForLocalInteraction: this.initialBottomPinDeferredForLocalInteraction,
            estimatedItemSizePx: this.estimatedItemSizePx,
            hasJumpTarget: false,
            itemCount: this.items.length,
            layoutHeightPx: this.layoutReady ? this.element.clientHeight : 0,
            listRef: {
                scrollToIndex: ({ index }) => {
                    if (options.simulateScrollToIndexFailure === true) {
                        return {
                            catch: (onRejected: () => void) => {
                                onRejected();
                                return undefined;
                            },
                        };
                    }
                    this.writeScrollTop(this.targetScrollTopForItemBottom(index));
                    return undefined;
                },
                scrollToOffset: ({ offset }) => {
                    this.writeScrollTop(offset);
                },
            },
            setAlreadyApplied: (applied) => {
                this.initialBottomPinAlreadyApplied = applied;
            },
        });
        if (!result.ok) {
            return {
                ok: false,
                reason: mapSidechainInitialBottomPinSkipReason(result.reason),
            };
        }
        const targetIndex = result.plan.targetIndex;
        const targetItem = this.items[targetIndex]!;

        return {
            ok: true,
            method: options.simulateScrollToIndexFailure === true
                ? 'estimated-offset-fallback'
                : 'scroll-to-index',
            targetIndex,
            targetIsFooter: false,
            targetItemId: targetItem.id,
            targetScrollTop: this.element.scrollTop,
        };
    }

    jumpToMessageId(
        messageId: string,
        options: Readonly<{ olderPages?: readonly (readonly SidechainShellRuntimeItem[])[] }> = {},
    ): SidechainJumpToMessageResult {
        const olderPages = options.olderPages ?? [];
        let loadedPages = 0;
        for (let attempt = 0; attempt < SIDECHAIN_SHELL_JUMP_MAX_OLDER_LOAD_ATTEMPTS; attempt += 1) {
            const targetIndex = this.findItemIndexForMessageId(messageId);
            if (targetIndex >= 0) {
                const targetScrollTop = this.targetScrollTopForItemCenter(targetIndex);
                this.writeScrollTop(targetScrollTop);
                return {
                    ok: true,
                    alignment: 'center',
                    loadedPages,
                    targetIndex,
                    targetItemId: this.items[targetIndex]!.id,
                    targetScrollTop: this.element.scrollTop,
                };
            }
            const nextPage = olderPages[loadedPages];
            if (!nextPage) break;
            this.items = [...nextPage, ...this.items];
            loadedPages += 1;
            this.syncScrollHeight();
        }
        return { ok: false, loadedPages, reason: 'not_found' };
    }

    async jumpToMessageIdThroughShellOperation(
        messageId: string,
        options: Readonly<{ olderPages?: readonly (readonly SidechainShellRuntimeItem[])[] }> = {},
    ): Promise<SidechainJumpToMessageResult> {
        const olderPages = options.olderPages ?? [];
        let loadedPages = 0;
        const result = await applySidechainJumpToMessageRequest({
            containsMessageId: (item, candidateMessageId) => item.containsMessageIds.includes(candidateMessageId),
            estimatedItemSizePx: this.estimatedItemSizePx,
            getItems: () => this.items,
            listRef: {
                scrollToIndex: ({ index }) => {
                    this.writeScrollTop(this.targetScrollTopForItemCenter(index));
                },
            },
            loadOlder: async () => {
                const nextPage = olderPages[loadedPages];
                if (!nextPage) {
                    return { loaded: 0, hasMore: false, status: 'no_more' };
                }
                this.items = [...nextPage, ...this.items];
                this.syncScrollHeight();
                loadedPages += 1;
                return {
                    loaded: nextPage.length,
                    hasMore: loadedPages < olderPages.length,
                    status: 'loaded',
                };
            },
            messageId,
            ownsMessageId: (item, candidateMessageId) => item.ownsMessageIds.includes(candidateMessageId),
            yieldForRender: async () => undefined,
        });
        if (!result.ok) {
            return { ok: false, loadedPages: result.loadedPages, reason: 'not_found' };
        }
        return {
            ok: true,
            alignment: 'center',
            loadedPages: result.loadedPages,
            targetIndex: result.targetIndex,
            targetItemId: result.targetItem.id,
            targetScrollTop: this.element.scrollTop,
        };
    }

    observeOlderLoad(params: Readonly<{
        offsetY: number;
        trigger?: OlderPaginationScrollTrigger;
    }>): SidechainOlderLoadObservation {
        return this.dispatchOlderObservation({
            offsetY: params.offsetY,
            trigger: params.trigger,
        });
    }

    observeWebOlderLoad(params: Readonly<{
        requestedTrigger?: WebDomOlderLoadObservationTrigger;
        scrollTop: number;
    }>): SidechainOlderLoadObservation {
        this.element.scrollTop = this.clampScrollTop(params.scrollTop);
        const ingress = params.requestedTrigger === 'edge-reached'
            ? resolveSidechainOlderLoadEdgeReachedObservation({
                nativeObservedOffset: this.resolveNativeObservedOffset(this.element.scrollTop),
                viewportGuardThresholdPx: this.resolveViewportGuardThresholdPx(),
                webElement: this.element,
            })
            : resolveSidechainOlderLoadScrollEventObservation({
                event: { nativeEvent: { target: this.element } },
                viewportGuardThresholdPx: this.resolveViewportGuardThresholdPx(),
            });
        if (!ingress.ok) return this.observeOlderState();
        return this.dispatchOlderObservation(ingress.observation);
    }

    onStartReached(): SidechainOlderLoadObservation {
        const ingress = resolveSidechainOlderLoadEdgeReachedObservation({
            nativeObservedOffset: this.resolveNativeObservedOffset(this.element.scrollTop),
            viewportGuardThresholdPx: this.resolveViewportGuardThresholdPx(),
            webElement: this.element,
        });
        if (!ingress.ok) return this.observeOlderState();
        return this.dispatchOlderObservation(ingress.observation);
    }

    cooldownElapsed(): SidechainOlderLoadObservation {
        this.olderState = reduceOlderPagination(this.olderState, { type: 'cooldownElapsed' });
        this.maybeStartOlderLoad();
        return this.observeOlderState();
    }

    finishOlderLoad(params: Readonly<{ loaded: number; hasMore: boolean }>): void {
        this.olderState = reduceOlderPagination(this.olderState, {
            type: 'loadFinished',
            loaded: params.loaded,
            hasMore: params.hasMore,
        });
    }

    applyWebLocalHeightChange(params: Readonly<{
        growthPx: number;
        mode: WebLocalHeightMode;
    }>): Readonly<{
        echoIsGenuineUserMovement: boolean;
        targetScrollTop: number;
    }> {
        const previousScrollTop = this.element.scrollTop;
        const previousScrollHeight = this.element.scrollHeight;
        this.element.scrollHeight += normalizeNonNegative(params.growthPx);
        const targetScrollTop = params.mode === 'follow-bottom'
            ? resolveWebTranscriptMaxScrollTop(this.metrics())
            : previousScrollTop + Math.max(0, this.element.scrollHeight - previousScrollHeight);
        this.observation.recordProgrammaticScrollTopWrite({
            element: this.element as unknown as HTMLElement,
            targetScrollTop,
        });
        const movement = this.observation.observeGenuineScrollMovement({
            distanceFromBottom: getWebTranscriptDistanceFromBottom(this.metrics()),
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: this.metrics(),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });
        return {
            echoIsGenuineUserMovement: movement.isGenuineUserMovement,
            targetScrollTop: this.element.scrollTop,
        };
    }

    applyWebPrependGrowth(params: Readonly<{ growthPx: number }>): Readonly<{
        echoIsGenuineUserMovement: boolean;
        growthPx: number;
        targetScrollTop: number;
    }> {
        const capturedMetrics = this.metrics();
        this.element.scrollHeight += normalizeNonNegative(params.growthPx);
        const result = applySidechainWebPrependGrowthRestore({
            capturedMetrics,
            webDomObservation: this.observation,
        });
        const movement = result.ok
            ? this.observation.observeGenuineScrollMovement({
                distanceFromBottom: getWebTranscriptDistanceFromBottom(this.metrics()),
                fallbackObservedScrollTop: null,
                isTrusted: true,
                metrics: this.metrics(),
                pinThresholdPx: 72,
                sustainFrames: 2,
            })
            : { isGenuineUserMovement: false };
        return {
            echoIsGenuineUserMovement: movement.isGenuineUserMovement,
            growthPx: result.ok ? result.growthPx : 0,
            targetScrollTop: this.element.scrollTop,
        };
    }

    async loadOlderPage(params: Readonly<{
        hasMore?: boolean;
        items: readonly SidechainShellRuntimeItem[];
        status?: SidechainOlderPageLoadResult['status'];
    }>): Promise<Readonly<{
        echoIsGenuineUserMovement: boolean;
        hasMore: boolean;
        loaded: number;
        status: SidechainOlderPageLoadResult['status'];
        targetScrollTop: number;
        visualUpdateCount: number;
    }>> {
        const capturedMetrics = this.metrics();
        let visualUpdateCount = 0;
        const status = params.status ?? 'loaded';
        const hasMore = params.hasMore ?? true;
        const result = await applySidechainOlderPageLoad({
            hasMoreOlder: this.olderState.hasMore,
            isLoadingOlder: false,
            loadOlder: async () => {
                this.items = [...params.items, ...this.items];
                this.syncScrollHeight();
                return {
                    loaded: params.items.length,
                    hasMore,
                    status,
                };
            },
            setHasMoreOlder: (nextHasMore) => {
                this.olderState = {
                    ...this.olderState,
                    hasMore: nextHasMore,
                };
            },
            setLoadingOlder: () => undefined,
            waitForVisualUpdate: async () => {
                visualUpdateCount += 1;
            },
            webDomObservation: this.observation,
            webPrependAnchor: capturedMetrics,
        });
        const movement = result
            ? this.observation.observeGenuineScrollMovement({
                distanceFromBottom: getWebTranscriptDistanceFromBottom(this.metrics()),
                fallbackObservedScrollTop: null,
                isTrusted: true,
                metrics: this.metrics(),
                pinThresholdPx: 72,
                sustainFrames: 2,
            })
            : { isGenuineUserMovement: false };
        return {
            echoIsGenuineUserMovement: movement.isGenuineUserMovement,
            hasMore: result?.hasMore ?? this.olderState.hasMore,
            loaded: result?.loaded ?? 0,
            status: result?.status ?? 'not_ready',
            targetScrollTop: this.element.scrollTop,
            visualUpdateCount,
        };
    }

    async loadOlderPageFromPagination(params: Readonly<{
        hasMore?: boolean;
        items: readonly SidechainShellRuntimeItem[];
        status?: SidechainOlderPageLoadResult['status'];
    }>): Promise<Readonly<{
        echoIsGenuineUserMovement: boolean;
        hasMore: boolean;
        loaded: number;
        status: SidechainOlderPageLoadResult['status'];
        targetScrollTop: number;
        visualUpdateCount: number;
    }>> {
        const status = params.status ?? 'loaded';
        const hasMore = params.hasMore ?? true;
        let visualUpdateCount = 0;
        const result = await applySidechainPaginationOlderPageLoad({
            hasMoreOlder: this.olderState.hasMore,
            listLayoutHeightPx: this.element.clientHeight,
            loadOlder: async (options) => {
                return await applySidechainOlderPageLoad({
                    hasMoreOlder: this.olderState.hasMore,
                    isLoadingOlder: false,
                    loadOlder: async () => {
                        this.items = [...params.items, ...this.items];
                        this.syncScrollHeight();
                        return {
                            loaded: params.items.length,
                            hasMore,
                            status,
                        };
                    },
                    setHasMoreOlder: (nextHasMore) => {
                        this.olderState = {
                            ...this.olderState,
                            hasMore: nextHasMore,
                        };
                    },
                    setLoadingOlder: () => undefined,
                    waitForVisualUpdate: async () => {
                        visualUpdateCount += 1;
                    },
                    webDomObservation: this.observation,
                    webPrependAnchor: options.webPrependAnchor,
                });
            },
            resolveViewportGuardThresholdPx: () => this.resolveViewportGuardThresholdPx(),
            resolveWebPrependAnchor: () => this.metrics(),
        });
        const movement = result
            ? this.observation.observeGenuineScrollMovement({
                distanceFromBottom: getWebTranscriptDistanceFromBottom(this.metrics()),
                fallbackObservedScrollTop: null,
                isTrusted: true,
                metrics: this.metrics(),
                pinThresholdPx: 72,
                sustainFrames: 2,
            })
            : { isGenuineUserMovement: false };
        return {
            echoIsGenuineUserMovement: movement.isGenuineUserMovement,
            hasMore: result?.hasMore ?? this.olderState.hasMore,
            loaded: result?.loaded ?? 0,
            status: result?.status ?? 'not_ready',
            targetScrollTop: this.element.scrollTop,
            visualUpdateCount,
        };
    }

    private dispatchOlderObservation(observation: SidechainOlderLoadObservationInput): SidechainOlderLoadObservation {
        const normalizedObservation = this.withNativeObservedOffset(observation);
        const applied = applySidechainOlderLoadObservation({
            contentHeightPx: this.element.scrollHeight,
            dataOrder: this.shellFrame.dataOrder,
            flashListContentHeightPx: this.element.scrollHeight,
            flashListLayoutHeightPx: this.element.clientHeight,
            getPaginationSnapshot: () => ({
                phase: this.olderState.phase,
                suspendedReasons: Array.from(this.olderState.suspendedReasons),
                hasMore: this.olderState.hasMore,
                insideThreshold: this.olderState.insideThreshold,
            }),
            itemCount: this.items.length,
            layoutHeightPx: this.element.clientHeight,
            observation: normalizedObservation,
            onScrollObservation: (metrics) => {
                this.dispatchOlderScroll(metrics);
            },
            platformOS: this.platformOS,
            recordTelemetry: null,
            rendererKind: this.rendererKind,
            sessionId: 'sidechain-runtime-contract',
            timestampMs: 0,
            viewportGuardThresholdPx: this.resolveViewportGuardThresholdPx(),
        });
        if (!applied) return this.observeOlderState();
        return this.observeOlderState();
    }

    private withNativeObservedOffset(
        observation: SidechainOlderLoadObservationInput,
    ): SidechainOlderLoadObservationInput {
        if (this.platformOS === 'web' || this.shellFrame.dataOrder !== 'newest-first') return observation;
        const rawOffsetY = typeof observation === 'number' ? observation : observation.offsetY;
        const nativeObservedOffset = this.resolveNativeObservedOffset(rawOffsetY);
        if (!nativeObservedOffset) return observation;
        if (typeof observation === 'number') {
            return {
                nativeObservedOffset,
                offsetY: nativeObservedOffset.canonicalOffsetY,
            };
        }
        return {
            ...observation,
            nativeObservedOffset,
            offsetY: nativeObservedOffset.canonicalOffsetY,
        };
    }

    private resolveNativeObservedOffset(
        rawOffsetY: number | null | undefined,
    ): TranscriptViewportObservedOffset | null {
        if (this.platformOS === 'web' || this.shellFrame.dataOrder !== 'newest-first') return null;
        if (typeof rawOffsetY !== 'number' || !Number.isFinite(rawOffsetY)) return null;
        return this.nativeFactSource.resolveObservedOffset(rawOffsetY, {
            contentHeight: this.contentReady ? this.element.scrollHeight : 0,
            layoutHeight: this.layoutReady ? this.element.clientHeight : 0,
        });
    }

    private dispatchOlderScroll(params: Readonly<{
        offsetY: number;
        scrollable: boolean;
        trigger?: OlderPaginationScrollTrigger;
    }>): SidechainOlderLoadObservation {
        this.olderState = reduceOlderPagination(this.olderState, {
            type: 'scrollObserved',
            offsetY: params.offsetY,
            scrollable: params.scrollable,
            thresholdPx: TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX,
            trigger: params.trigger,
        });
        this.maybeStartOlderLoad();
        return this.observeOlderState();
    }

    private maybeStartOlderLoad(): void {
        if (!shouldLoadNow(this.olderState)) return;
        this.olderState = reduceOlderPagination(this.olderState, { type: 'loadStarted' });
        this.loadCount += 1;
    }

    private observeOlderState(): SidechainOlderLoadObservation {
        return {
            loadCount: this.loadCount,
            phase: this.olderState.phase,
            shouldLoad: this.olderState.phase === 'loading',
        };
    }

    private findItemIndexForMessageId(messageId: string): number {
        const owner = this.items.findIndex((item) => item.ownsMessageIds.includes(messageId));
        if (owner >= 0) return owner;
        return this.items.findIndex((item) => item.containsMessageIds.includes(messageId));
    }

    private itemTop(index: number): number {
        let top = 0;
        for (let i = 0; i < index; i += 1) {
            top += this.items[i]?.heightPx ?? 0;
        }
        return top;
    }

    private targetScrollTopForItemBottom(index: number): number {
        const item = this.items[index];
        if (!item) return 0;
        return this.itemTop(index) + item.heightPx - this.layoutHeightPx;
    }

    private targetScrollTopForItemCenter(index: number): number {
        const item = this.items[index];
        if (!item) return 0;
        return this.itemTop(index) + item.heightPx / 2 - this.layoutHeightPx / 2;
    }

    private contentHeightPx(): number {
        let total = this.footerHeightPx;
        for (const item of this.items) {
            total += item.heightPx;
        }
        return total;
    }

    private maxScrollTop(): number {
        return Math.max(0, this.element.scrollHeight - this.element.clientHeight);
    }

    private resolveViewportGuardThresholdPx(): number {
        return Math.min(
            TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
            Math.max(
                TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
                this.element.clientHeight * TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            ),
        );
    }

    private clampScrollTop(value: number): number {
        return clamp(value, 0, this.maxScrollTop());
    }

    private writeScrollTop(value: number): void {
        this.element.scrollTop = this.clampScrollTop(value);
    }

    private syncScrollHeight(): void {
        this.element.scrollHeight = this.contentHeightPx();
        this.element.scrollTop = this.clampScrollTop(this.element.scrollTop);
    }

    private metrics(): WebTranscriptScrollMetrics {
        const element = this.element;
        return {
            element: element as unknown as HTMLElement,
            get scrollTop() {
                return element.scrollTop;
            },
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        };
    }

    private sidechainCapability(): Extract<TranscriptListShellCapability, { kind: 'sidechain' }> {
        const capability = this.shellFrame.capability;
        if (capability.kind === 'sidechain') return capability;
        throw new Error(`Unexpected sidechain shell capability: ${capability.kind}`);
    }
}

export function createSidechainShellRuntimeModel(
    options: SidechainShellRuntimeModelOptions,
): SidechainShellRuntimeModel {
    return new SidechainShellRuntimeModel(options);
}

export type ReadOnlyShellRuntimeModelOptions = Readonly<{
    bottomNotice: boolean;
    hasThinkingMessage: boolean;
    messageCount: number;
    platformOS: string;
    rowHeightPx?: number;
    viewportHeightPx?: number;
}>;

export class ReadOnlyShellRuntimeModel {
    private readonly hasThinkingMessage: boolean;
    private readonly messageCount: number;
    private readonly rowHeightPx: number;
    private readonly rendererKind: TranscriptListRendererKind;
    private readonly shellFrame: TranscriptListShellFrame;
    private readonly viewportHeightPx: number;
    private readonly expandedThinkingMessageIds = new Set<string>();
    private scrollTop = 0;

    constructor(options: ReadOnlyShellRuntimeModelOptions) {
        this.hasThinkingMessage = options.hasThinkingMessage;
        this.messageCount = options.messageCount;
        this.rowHeightPx = options.rowHeightPx ?? 100;
        this.rendererKind = 'flashList';
        this.shellFrame = resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: options.bottomNotice,
            platformOS: options.platformOS,
            rendererKind: this.rendererKind,
        });
        this.viewportHeightPx = options.viewportHeightPx ?? 600;
        if (this.shellFrame.capability.kind === 'readOnly') {
            this.scrollTop = this.maxScrollTop();
        }
    }

    observeCapability(): Readonly<{
        accessKind: 'public';
        bottomNoticeVisible: boolean;
        canApprovePermissions: false;
        canSendMessages: false;
        composerVisible: false;
        flashListStartsFromBottom: boolean;
        permissionDisabledReason: 'public';
        toolNavigationDisabled: true;
    }> {
        const capability = this.readOnlyCapability();
        return {
            accessKind: capability.accessKind,
            bottomNoticeVisible: capability.bottomNoticeVisible,
            canApprovePermissions: capability.canApprovePermissions,
            canSendMessages: capability.canSendMessages,
            composerVisible: capability.composerVisible,
            flashListStartsFromBottom: capability.flashListStartsFromBottom,
            permissionDisabledReason: capability.permissionDisabledReason,
            toolNavigationDisabled: capability.toolNavigationDisabled,
        };
    }

    observeFrame(): Readonly<{
        dataOrder: TranscriptListShellFrame['dataOrder'];
        renderer: TranscriptListRendererKind;
    }> {
        return {
            dataOrder: this.shellFrame.dataOrder,
            renderer: this.rendererKind,
        };
    }

    toggleThinkingExpansion(messageId: string): Readonly<{ expanded: boolean; messageId: string }> {
        if (!this.hasThinkingMessage) {
            return { expanded: false, messageId };
        }
        if (this.expandedThinkingMessageIds.has(messageId)) {
            this.expandedThinkingMessageIds.delete(messageId);
            return { expanded: false, messageId };
        }
        this.expandedThinkingMessageIds.add(messageId);
        return { expanded: true, messageId };
    }

    scrollTo(scrollTop: number): void {
        this.scrollTop = clamp(scrollTop, 0, this.maxScrollTop());
    }

    observeScroll(): Readonly<{
        maxScrollTop: number;
        scrollHeight: number;
        scrollTop: number;
        viewportHeight: number;
    }> {
        return {
            maxScrollTop: this.maxScrollTop(),
            scrollHeight: this.scrollHeight(),
            scrollTop: this.scrollTop,
            viewportHeight: this.viewportHeightPx,
        };
    }

    rerenderSameRows(): void {
        this.scrollTop = clamp(this.scrollTop, 0, this.maxScrollTop());
    }

    private scrollHeight(): number {
        return this.messageCount * this.rowHeightPx;
    }

    private maxScrollTop(): number {
        return Math.max(0, this.scrollHeight() - this.viewportHeightPx);
    }

    private readOnlyCapability(): TranscriptListShellReadOnlyCapability {
        const capability = this.shellFrame.capability;
        if (capability.kind === 'readOnly') {
            return capability;
        }
        throw new Error(`Unexpected read-only shell capability: ${capability.kind}`);
    }
}

export function createReadOnlyShellRuntimeModel(
    options: ReadOnlyShellRuntimeModelOptions,
): ReadOnlyShellRuntimeModel {
    return new ReadOnlyShellRuntimeModel(options);
}

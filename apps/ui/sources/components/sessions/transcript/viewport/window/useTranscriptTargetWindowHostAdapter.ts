import * as React from 'react';

import { applyTranscriptJumpResult } from '../jump/applyTranscriptJumpResult';
import { resolveTranscriptJumpStrategy } from '../jump/resolveTranscriptJumpStrategy';
import type {
    TranscriptJumpResult,
    TranscriptJumpTarget,
    TranscriptJumpTargetIndexResult,
    TranscriptJumpTargetRole,
} from '../jump/transcriptJumpTargetTypes';
import { resolveTargetWindowAlignmentCommand } from '../driver/targetWindowAlignmentCommand';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationJumpRequest,
} from '../../navigation/transcriptNavigationTypes';
import type { TranscriptViewportJumpAlignment } from '../transcriptViewportTypes';
import { resolveTranscriptTargetWindowDisplay } from './resolveTranscriptTargetWindowDisplay';
import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowDisplayResult,
    TranscriptTargetWindowState,
} from './transcriptTargetWindowTypes';

export type TranscriptTargetWindowHostFacts<TItem extends TranscriptTargetWindowDisplayItem> = Readonly<{
    activeWindowState: TranscriptTargetWindowState | null;
    display: TranscriptTargetWindowDisplayResult<TItem> | null;
    hasMoreNewer: boolean;
    items: readonly TItem[];
    targetWindowActive: boolean;
}>;

export function resolveTranscriptTargetWindowHostFacts<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    resolveSeq?: (item: TItem) => number | null | undefined;
    windowState: TranscriptTargetWindowState;
}>): TranscriptTargetWindowHostFacts<TItem> {
    const activeWindowState = params.windowState.isWindowMode ? params.windowState : null;
    const display = activeWindowState
        ? resolveTranscriptTargetWindowDisplay({
            items: params.items,
            windowState: activeWindowState,
            resolveSeq: params.resolveSeq,
        })
        : null;
    return {
        activeWindowState,
        display,
        hasMoreNewer: activeWindowState?.hasMoreNewer === true,
        items: display?.items ?? params.items,
        targetWindowActive: activeWindowState !== null,
    };
}

export function useTranscriptTargetWindowHostAdapter<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    resolveSeq?: (item: TItem) => number | null | undefined;
    windowState: TranscriptTargetWindowState;
}>): TranscriptTargetWindowHostFacts<TItem> {
    return React.useMemo(() => resolveTranscriptTargetWindowHostFacts(params), [
        params.items,
        params.resolveSeq,
        params.windowState,
    ]);
}

export type TranscriptJumpTargetRequest = Readonly<{
    normalizedTargetSeq: number;
    role: TranscriptJumpTargetRole | null | undefined;
    routeMessageId: string | null;
    transcriptBlockIndex: number | null | undefined;
}>;

export function resolveTranscriptJumpTargetRequest(target: TranscriptJumpTarget): TranscriptJumpTargetRequest | null {
    const targetSeq = target.kind === 'seq' ? target.seq : target.seqHint;
    if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq) || targetSeq < 0) return null;
    return {
        normalizedTargetSeq: Math.trunc(targetSeq),
        routeMessageId: target.kind === 'route-message-id' ? target.routeMessageId : null,
        transcriptBlockIndex: target.kind === 'route-message-id' ? target.transcriptBlockIndex : null,
        role: target.kind === 'route-message-id' ? target.role : null,
    };
}

export function resolveTranscriptTargetWindowLoadTarget(
    target: TranscriptJumpTarget,
    fallbackSeq: number,
): { kind: 'seq'; seq: number } | { kind: 'route-message-id'; routeMessageId: string; seqHint: number } {
    return target.kind === 'seq'
        ? { kind: 'seq', seq: Math.trunc(target.seq) }
        : {
            kind: 'route-message-id',
            routeMessageId: target.routeMessageId,
            seqHint: Math.trunc(target.seqHint ?? fallbackSeq),
        };
}

export function isTranscriptSeqMountedInWebRenderedWindow<TItem>(params: Readonly<{
    hasAnyTestId: (container: Element, testIds: readonly string[]) => boolean;
    hotTailTestIdPrefix: string;
    items: readonly TItem[];
    platformOS: string;
    prependAnchorTestIdPrefix: string;
    resolveContainer: () => Element | null | undefined;
    resolveItemId: (item: TItem) => string | null | undefined;
    resolveSeq: (item: TItem) => number | null | undefined;
    seq: number;
}>): boolean {
    if (params.platformOS !== 'web') return false;
    if (typeof params.seq !== 'number' || !Number.isFinite(params.seq)) return false;
    const container = params.resolveContainer();
    if (!container) return false;
    const normalizedSeq = Math.trunc(params.seq);
    for (const item of params.items) {
        if (params.resolveSeq(item) !== normalizedSeq) continue;
        const normalizedItemId = params.resolveItemId(item)?.trim();
        if (!normalizedItemId) continue;
        if (params.hasAnyTestId(container, [
            `${params.prependAnchorTestIdPrefix}${normalizedItemId}`,
            `${params.hotTailTestIdPrefix}${normalizedItemId}`,
        ])) return true;
    }
    return false;
}

export function resolveTranscriptNavigationJumpPlan(params: Readonly<{
    entry: TranscriptNavigationEntry;
    isTargetInRenderedWindow: (target: TranscriptJumpTarget) => boolean;
    request: TranscriptNavigationJumpRequest;
    sessionId: string;
}>): Readonly<{
    align: TranscriptViewportJumpAlignment;
    preferTargetWindow: boolean;
    target: TranscriptJumpTarget;
}> | null {
    const { entry, request } = params;
    const scope = request.scope;
    if (scope.kind !== 'main' || scope.sessionId !== params.sessionId) return null;
    const targetSeq = request.target.kind === 'seq' ? request.target.seq : request.target.seqHint ?? entry.seq;
    if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq)) return null;
    const target = request.target.kind === 'route-message-id' && typeof request.target.seqHint !== 'number' && typeof entry.seq === 'number'
        ? { ...request.target, seqHint: entry.seq }
        : request.target;
    return {
        align: resolveTargetWindowAlignmentCommand({
            anchorKind: entry.kind,
            requestedAlign: request.align,
        }),
        preferTargetWindow: entry.loaded === false || (
            target.kind === 'route-message-id' &&
            !params.isTargetInRenderedWindow(target)
        ),
        target,
    };
}

export function resolveTranscriptNavigationPaneJumpRequest(
    entry: TranscriptNavigationEntry,
    sessionId: string,
): TranscriptNavigationJumpRequest | null {
    if (entry.sessionId !== sessionId) return null;
    if (typeof entry.seq !== 'number' || !Number.isFinite(entry.seq)) return null;
    return {
        align: entry.kind === 'user-turn' ? 'top' : 'center',
        scope: { kind: 'main', sessionId },
        source: 'panel',
        target: entry.routeMessageId
            ? {
                kind: 'route-message-id',
                role: entry.role,
                routeMessageId: entry.routeMessageId,
                seqHint: entry.seq,
                transcriptBlockIndex: entry.transcriptBlockIndex,
            }
            : { kind: 'seq', seq: entry.seq },
    };
}

export function resolveTranscriptRouteJumpSeqPlan(params: Readonly<{
    committedMessagesCount: number;
    hasUsableWebMetrics: () => boolean;
    inFlightJumpSeq: number | null;
    isLoaded: boolean;
    jumpToSeq: number | null | undefined;
    lastJumpSeq: number | null;
    listContentHeight: number;
    listLayoutHeight: number;
    platformOS: string;
    sessionId: string | null | undefined;
}>): number | null {
    const target = params.jumpToSeq;
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;
    if (!params.isLoaded && !(params.platformOS === 'web' && params.committedMessagesCount > 0)) return null;
    if (params.platformOS === 'web' && (params.listLayoutHeight <= 0 || params.listContentHeight <= 0) && !params.hasUsableWebMetrics()) {
        return null;
    }
    const normalizedTarget = Math.trunc(target);
    if (params.lastJumpSeq === normalizedTarget || params.inFlightJumpSeq === normalizedTarget) return null;
    if (!params.sessionId) return null;
    return normalizedTarget;
}

export async function executeTranscriptTargetWindowJump(params: Readonly<{
    align?: TranscriptViewportJumpAlignment;
    canRenderTargetWindow: boolean;
    forceTargetWindow?: boolean;
    isTargetInRenderedWindow?: () => boolean;
    isTargetMounted: () => boolean;
    loadTargetWindow: (request: Readonly<{
        direction: 'older' | 'newer' | null;
        target: TranscriptJumpTarget;
        targetSeq: number;
    }>) => Promise<{
        windowId: string;
        targetSeq?: number | null;
        newerCursor?: number | null;
        hasMoreNewer?: boolean | null;
    } | { status: 'stale' } | null>;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    pageTowardTarget?: (request: Readonly<{
        direction: 'older' | 'newer';
        nearestIndex: number;
        nearestSeq: number;
        target: TranscriptJumpTarget;
        targetSeq: number;
    }>) => Promise<TranscriptJumpResult>;
    platformOS: string;
    readScrollTop: () => number | null;
    resolveTargetIndex: () => TranscriptJumpTargetIndexResult;
    scrollToTarget: () => boolean;
    target: TranscriptJumpTarget;
    targetSeq: number;
}>): Promise<TranscriptJumpResult> {
    const scrollToTarget = (): boolean => {
        const beforeScrollTop = params.canRenderTargetWindow && params.platformOS === 'web'
            ? params.readScrollTop()
            : null;
        const applied = params.scrollToTarget();
        if (!applied) return false;
        if (params.canRenderTargetWindow && params.platformOS === 'web') {
            const targetInRenderedWindow = params.isTargetInRenderedWindow?.() ?? params.isTargetMounted();
            if (!targetInRenderedWindow) return false;
        }
        if (params.canRenderTargetWindow && params.platformOS === 'web' && !params.isTargetMounted()) {
            const afterScrollTop = params.readScrollTop();
            if (
                beforeScrollTop != null &&
                afterScrollTop != null &&
                Math.abs(afterScrollTop - beforeScrollTop) <= 1
            ) {
                return false;
            }
        }
        return true;
    };
    const renderTargetWindow = async (
        request: Readonly<{
            direction: 'older' | 'newer' | null;
            target: TranscriptJumpTarget;
            targetSeq: number;
        }>,
    ) => {
        return await params.loadTargetWindow(request);
    };

    const resolvedTargetIndex = params.resolveTargetIndex();
    const strategy = params.forceTargetWindow === true && params.canRenderTargetWindow && resolvedTargetIndex.status !== 'found'
        ? {
            status: 'render-target-window' as const,
            target: params.target,
            direction: resolvedTargetIndex.status === 'unresolved' ? resolvedTargetIndex.direction : null,
            targetSeq: params.targetSeq,
        }
        : resolveTranscriptJumpStrategy({
        target: params.target,
        scope: { kind: 'main', sessionId: 'host-adapter' },
        targetIndex: resolvedTargetIndex,
        mode: 'mounted-list',
        nearbySeqThreshold: 8,
        canRenderTargetWindow: params.canRenderTargetWindow,
    });

    const result = await applyTranscriptJumpResult({
        strategy,
        adapters: {
            scrollToIndex: () => scrollToTarget(),
            renderTargetWindow: params.canRenderTargetWindow
                ? ({ target, targetSeq, direction }) => renderTargetWindow({ target, targetSeq, direction })
                : undefined,
            pageTowardTarget: params.pageTowardTarget,
        },
    });

    if (result.status === 'scrolled') {
        params.onJumpLanded?.(result);
        return result;
    }
    if (result.status === 'window-rendered' && params.platformOS !== 'web') {
        params.scrollToTarget();
        params.onJumpLanded?.(result);
        return result;
    }
    if (result.status === 'window-rendered' && params.platformOS === 'web') {
        if (params.isTargetMounted()) {
            params.onJumpLanded?.(result);
            return result;
        }
        await Promise.resolve();
        await Promise.resolve();
        if (params.isTargetMounted()) {
            params.onJumpLanded?.(result);
        }
        return result;
    }
    if (
        params.canRenderTargetWindow &&
        strategy.status === 'scroll-mounted' &&
        result.status === 'not-found'
    ) {
        const fallbackResult = await applyTranscriptJumpResult({
            strategy: {
                status: 'render-target-window',
                target: params.target,
                direction: null,
                targetSeq: params.targetSeq,
            },
            adapters: {
                renderTargetWindow: ({ target, targetSeq, direction }) => renderTargetWindow({ target, targetSeq, direction }),
            },
        });
        if (fallbackResult.status === 'window-rendered') {
            if (params.platformOS !== 'web' || params.isTargetMounted()) {
                params.onJumpLanded?.(fallbackResult);
            } else {
                await Promise.resolve();
                await Promise.resolve();
                if (params.isTargetMounted()) {
                    params.onJumpLanded?.(fallbackResult);
                }
            }
        }
        return fallbackResult;
    }
    return result;
}

import React from 'react';
import { FlatList, View } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

import { CodeLineRow } from './CodeLineRow';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { buildCodeLineRange, isCodeLineRangeSelectionEvent } from '../interactions/resolveCodeLineRangeSelection';

export type CodeLinesViewProps = {
    lines: readonly CodeLine[];
    selectedLineIds?: ReadonlySet<string>;
    onPressLine?: (line: CodeLine, event?: unknown) => void;
    onPressLineRange?: (lines: readonly CodeLine[]) => void;
    pressLineWhenNotSelectable?: boolean;
    onPressAddComment?: (line: CodeLine) => void;
    isCommentActive?: (line: CodeLine) => boolean;
    renderAfterLine?: (line: CodeLine) => React.ReactNode;
    showInactiveCommentAffordance?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    wrapLines?: boolean;
    virtualized?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    scrollToLineId?: string;
    highlightLineId?: string;
    highlightLineIds?: ReadonlySet<string>;
    testID?: string;
    onLayout?: (e: any) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (e: any) => void;
    scrollEventThrottle?: number;
};

type InlineToken = Readonly<{ text: string; color: string }>;
type PreventableEvent = Readonly<{
    preventDefault?: () => void;
    nativeEvent?: Readonly<{ preventDefault?: () => void }>;
}>;

const EMPTY_LINE_ID_SET: ReadonlySet<string> = new Set();
const VIRTUALIZED_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
const LIST_FOOTER_STYLE = { height: 16 } as const;

function preventNativeTextSelection(event?: PreventableEvent): void {
    event?.preventDefault?.();
    event?.nativeEvent?.preventDefault?.();
}

export function CodeLinesViewCore(
    props: CodeLinesViewProps & Readonly<{
        getAdvancedTokens?: (index: number) => readonly InlineToken[] | null | undefined;
        advancedTokensRevision?: number;
    }>
) {
    const selected = props.selectedLineIds ?? EMPTY_LINE_ID_SET;
    const highlighted = props.highlightLineIds ?? EMPTY_LINE_ID_SET;
    const paddingHorizontal = props.contentPaddingHorizontal ?? 0;
    const paddingVertical = props.contentPaddingVertical ?? 0;
    const wrapLines = props.wrapLines ?? true;
    const virtualized = props.virtualized ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;
    const advancedTokensRevision = props.advancedTokensRevision ?? 0;
    const activeRangeStartLineIdRef = React.useRef<string | null>(null);
    const lastPressedLineIdRef = React.useRef<string | null>(null);

    const onBeginLineRangeSelection = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!props.onPressLineRange || line.renderIsHeaderLine) return;
        preventNativeTextSelection(event);
        activeRangeStartLineIdRef.current = line.id;
    }, [props.onPressLineRange]);

    const onEnterLineRangeSelection = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        const startLineId = activeRangeStartLineIdRef.current;
        if (!startLineId || !props.onPressLineRange || line.renderIsHeaderLine) return;
        preventNativeTextSelection(event);
        if (startLineId === line.id) return;
        const rangeLines = buildCodeLineRange({
            lines: props.lines,
            fromLineId: startLineId,
            toLineId: line.id,
        });
        if (rangeLines.length > 0) props.onPressLineRange(rangeLines);
    }, [props.lines, props.onPressLineRange]);

    const onEndLineRangeSelection = React.useCallback((event?: PreventableEvent) => {
        preventNativeTextSelection(event);
        activeRangeStartLineIdRef.current = null;
    }, []);

    const onPressLine = React.useCallback((line: CodeLine, event?: unknown) => {
        if (line.renderIsHeaderLine) return;
        const previousLineId = lastPressedLineIdRef.current;
        if (
            previousLineId &&
            previousLineId !== line.id &&
            props.onPressLineRange &&
            isCodeLineRangeSelectionEvent(event)
        ) {
            const rangeLines = buildCodeLineRange({
                lines: props.lines,
                fromLineId: previousLineId,
                toLineId: line.id,
            });
            if (rangeLines.length > 0) {
                props.onPressLineRange(rangeLines);
                lastPressedLineIdRef.current = line.id;
                return;
            }
        }

        props.onPressLine?.(line, event);
        lastPressedLineIdRef.current = line.id;
    }, [props.lines, props.onPressLine, props.onPressLineRange]);

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: props.lines, config: props.syntaxHighlighting });
    }, [props.lines, props.syntaxHighlighting]);

    const renderLine = React.useCallback((item: CodeLine, index: number) => (
        <View>
            <CodeLineRow
                line={item}
                selected={selected.has(item.id)}
                highlighted={props.highlightLineId === item.id || highlighted.has(item.id)}
                onPressLine={onPressLine}
                onBeginLineRangeSelection={props.onPressLineRange ? onBeginLineRangeSelection : undefined}
                onEnterLineRangeSelection={props.onPressLineRange ? onEnterLineRangeSelection : undefined}
                onEndLineRangeSelection={props.onPressLineRange ? onEndLineRangeSelection : undefined}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                commentActive={props.isCommentActive ? props.isCommentActive(item) : false}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showPrefix}
                syntaxHighlighting={effectiveSyntaxHighlighting}
                advancedTokens={effectiveSyntaxHighlighting.mode === 'advanced' ? (props.getAdvancedTokens?.(index) ?? undefined) : undefined}
            />
            {props.renderAfterLine ? props.renderAfterLine(item) : null}
        </View>
    ), [
        effectiveSyntaxHighlighting,
        highlighted,
        onBeginLineRangeSelection,
        onEndLineRangeSelection,
        onEnterLineRangeSelection,
        onPressLine,
        props.getAdvancedTokens,
        props.highlightLineId,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        props.showInactiveCommentAffordance,
        selected,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const renderItem = React.useCallback(({ item, index }: { item: CodeLine; index: number }) => {
        return renderLine(item, index);
    }, [renderLine]);

    const contentContainerStyle = React.useMemo(() => ({
        paddingHorizontal,
        paddingVertical,
    }), [paddingHorizontal, paddingVertical]);

    const listFooterComponent = React.useMemo(() => <View style={LIST_FOOTER_STYLE} />, []);

    const listRef = React.useRef<FlatList<CodeLine> | null>(null);

    const scrollIndex = React.useMemo(() => {
        const id = props.scrollToLineId;
        if (!id) return -1;
        return props.lines.findIndex((l) => l.id === id);
    }, [props.lines, props.scrollToLineId]);

    const estimatedRowHeight = 22;

    const getItemLayout = React.useCallback((_: unknown, index: number) => {
        // A best-effort constant-height layout to make scroll-to-index reliable on React Native Web.
        // If a line wraps, the offset can be slightly off, but the highlight still guides the user.
        return {
            length: estimatedRowHeight,
            offset: estimatedRowHeight * index,
            index,
        };
    }, [estimatedRowHeight]);

    React.useEffect(() => {
        if (scrollIndex < 0) return;
        const targetId = props.scrollToLineId;
        if (!targetId) return;
        const firstLineId = props.lines[0]?.id ?? null;

        let cancelled = false;

        const tryScrollIntoView = (): boolean => {
            if (typeof document === 'undefined') return false;
            // React Native Web maps `nativeID` to DOM `id`.
            const el = (document as any)?.getElementById?.(String(targetId));
            if (!el) return false;
            if (typeof el.scrollIntoView !== 'function') return false;
            try {
                el.scrollIntoView({ block: 'center' });
                return true;
            } catch {
                return false;
            }
        };

        const tryScrollDomOffset = (): boolean => {
            if (typeof document === 'undefined') return false;
            const doc: any = document as any;
            const fallbackAnchor = doc?.getElementById?.(String(targetId))
                ?? (firstLineId ? doc?.getElementById?.(String(firstLineId)) : null);
            if (!fallbackAnchor) return false;

            let el = fallbackAnchor.parentElement;
            let steps = 0;
            while (el && steps < 30) {
                const overflowY = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
                    ? window.getComputedStyle(el).overflowY
                    : null;
                const overflowOk = overflowY ? (overflowY === 'auto' || overflowY === 'scroll') : true;
                if (overflowOk && el.scrollHeight > el.clientHeight + 5) {
                    const top = estimatedRowHeight * scrollIndex;
                    try {
                        if (typeof el.scrollTo === 'function') {
                            el.scrollTo({ top });
                        } else {
                            el.scrollTop = top;
                        }
                    } catch {
                        try {
                            el.scrollTop = estimatedRowHeight * scrollIndex;
                        } catch {
                            // ignore
                        }
                    }
                    return true;
                }
                el = el.parentElement;
                steps++;
            }

            return false;
        };

        const attemptScroll = () => {
            if (cancelled) return;
            // Defer until after layout to avoid "no item at index" on first paint.
            try {
                listRef.current?.scrollToIndex({ index: scrollIndex, viewPosition: 0.25, animated: true });
            } catch {
                // ignore
            }
            // React Native Web sometimes fails to forward FlatList refs; fall back to DOM scrollTop.
            tryScrollDomOffset();
            tryScrollIntoView();
        };

        let attempts = 0;
        let timer: any = null;
        const tick = () => {
            attempts += 1;
            attemptScroll();
            if (cancelled) return;
            // Retry briefly to catch layout + virtualization rendering on web.
            if (attempts < 6 && typeof document !== 'undefined') {
                timer = setTimeout(tick, 50);
            }
        };

        timer = setTimeout(tick, 0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [estimatedRowHeight, props.lines, props.scrollToLineId, scrollIndex]);

    // FlatList is a PureComponent: when behavior depends on props outside `data`, we must provide `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => ({
        selectedLineIds: props.selectedLineIds,
        renderAfterLine: props.renderAfterLine,
        onPressLine: props.onPressLine,
        onPressLineRange: props.onPressLineRange,
        pressLineWhenNotSelectable: props.pressLineWhenNotSelectable,
        onPressAddComment: props.onPressAddComment,
        isCommentActive: props.isCommentActive,
        showInactiveCommentAffordance: props.showInactiveCommentAffordance,
        wrapLines,
        showLineNumbers,
        showPrefix,
        syntaxHighlighting: effectiveSyntaxHighlighting,
        highlightLineId: props.highlightLineId,
        highlightLineIds: props.highlightLineIds,
        advancedTokensRevision,
    } as const), [
        effectiveSyntaxHighlighting,
        advancedTokensRevision,
        props.highlightLineId,
        props.highlightLineIds,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLine,
        onPressLine,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        props.selectedLineIds,
        props.showInactiveCommentAffordance,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    if (!virtualized) {
        return (
            <View style={{ paddingHorizontal, paddingVertical }}>
                {props.lines.map((line, index) => (
                    <React.Fragment key={line.id}>
                        {renderLine(line, index)}
                    </React.Fragment>
                ))}
                <View style={{ height: 16 }} />
            </View>
        );
    }

    return (
        <FlatList
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as any;
            }}
            data={props.lines as CodeLine[]}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            extraData={listExtraData}
            testID={props.testID}
            style={VIRTUALIZED_LIST_STYLE}
            disableVirtualization={!virtualized}
            initialScrollIndex={scrollIndex >= 0 ? scrollIndex : undefined}
            getItemLayout={wrapLines ? undefined : getItemLayout}
            contentContainerStyle={contentContainerStyle}
            ListFooterComponent={listFooterComponent}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onScroll={props.onScroll}
            scrollEventThrottle={props.scrollEventThrottle}
            onScrollToIndexFailed={(info) => {
                // Best-effort retry: FlatList can fail if measurement hasn't completed yet.
                try {
                    listRef.current?.scrollToOffset({
                        offset: info.averageItemLength * info.index,
                        animated: true,
                    });
                } catch {
                    // ignore
                }
                setTimeout(() => {
                    try {
                        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.25, animated: true });
                    } catch {
                        // ignore
                    }
                }, 50);
            }}
        />
    );
}

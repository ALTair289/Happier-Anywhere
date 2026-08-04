import * as React from 'react';

import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';
import { repairStreamingMarkdownAsync } from './repairStreamingMarkdownAsync';
import {
    STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
    STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS,
} from './streamingMarkdownRepairConfig';

type PreparedStreamingMarkdownState = Readonly<{
    sourceMarkdown: string;
    preparedMarkdown: string;
}>;

export type MarkdownStreamingMode = 'static' | 'streaming';

function shouldUseAsyncStreamingRepair(markdown: string): boolean {
    return markdown.length >= STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS;
}

/**
 * Resolves the markdown a streaming message renders.
 *
 * Repairing unterminated markdown costs O(n^2) in the message length, so past
 * {@link STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS} the repair moves off the render path. The
 * rendered document must still only ever come from a repaired source: rendering the raw markdown
 * between repairs makes already-visible prose revert to literal syntax (`the docs` back to
 * `[the docs](https://exa`) on every chunk. While a newer chunk is still being repaired the hook
 * therefore keeps returning the newest repaired ancestor of the current markdown, and the repair is
 * scheduled so that it always lands rather than being cancelled by the next chunk.
 */
export function usePreparedStreamingMarkdown(params: Readonly<{
    markdown: string;
    mode: MarkdownStreamingMode;
}>): string {
    const markdown = typeof params.markdown === 'string' ? params.markdown : '';
    const useAsyncRepair = params.mode === 'streaming' && shouldUseAsyncStreamingRepair(markdown);
    const [preparedState, setPreparedState] = React.useState<PreparedStreamingMarkdownState | null>(null);
    const pendingMarkdownRef = React.useRef<string | null>(null);
    const repairedSourceRef = React.useRef<string | null>(null);
    const repairTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const repairInFlightRef = React.useRef(false);
    const lastSyncPreparedRef = React.useRef<PreparedStreamingMarkdownState | null>(null);

    const syncPreparedMarkdown = React.useMemo(() => {
        if (params.mode !== 'streaming') return markdown;
        if (useAsyncRepair) return null;
        const preparedMarkdown = preprocessStreamingMarkdown(markdown);
        // Caches the newest synchronously repaired document so growing past the async threshold
        // mid-stream does not paint one raw frame before the first async repair lands.
        lastSyncPreparedRef.current = { sourceMarkdown: markdown, preparedMarkdown };
        return preparedMarkdown;
    }, [markdown, params.mode, useAsyncRepair]);

    const scheduleAsyncRepair = React.useCallback(function scheduleAsyncRepair() {
        if (repairTimeoutRef.current != null || repairInFlightRef.current) return;

        repairTimeoutRef.current = setTimeout(() => {
            repairTimeoutRef.current = null;
            const requestedMarkdown = pendingMarkdownRef.current;
            if (requestedMarkdown == null || requestedMarkdown === repairedSourceRef.current) return;

            const finishRepair = (preparedMarkdown: string) => {
                if (pendingMarkdownRef.current == null) return;
                repairedSourceRef.current = requestedMarkdown;
                setPreparedState({ sourceMarkdown: requestedMarkdown, preparedMarkdown });
                if (pendingMarkdownRef.current !== requestedMarkdown) scheduleAsyncRepair();
            };

            repairInFlightRef.current = true;
            void repairStreamingMarkdownAsync(requestedMarkdown).then(
                (preparedMarkdown) => {
                    repairInFlightRef.current = false;
                    finishRepair(preparedMarkdown);
                },
                () => {
                    repairInFlightRef.current = false;
                    finishRepair(preprocessStreamingMarkdown(requestedMarkdown));
                },
            );
        }, STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS);
    }, []);

    React.useEffect(() => {
        if (!useAsyncRepair) {
            pendingMarkdownRef.current = null;
            repairedSourceRef.current = null;
            if (repairTimeoutRef.current != null) {
                clearTimeout(repairTimeoutRef.current);
                repairTimeoutRef.current = null;
            }
            setPreparedState((current) => current == null ? current : null);
            return;
        }

        // Deliberately does not cancel an already scheduled repair: cancelling on every chunk lets a
        // fast stream starve the repair indefinitely, which is what leaves raw markdown on screen.
        pendingMarkdownRef.current = markdown;
        scheduleAsyncRepair();
    }, [markdown, scheduleAsyncRepair, useAsyncRepair]);

    React.useEffect(() => () => {
        pendingMarkdownRef.current = null;
        if (repairTimeoutRef.current != null) {
            clearTimeout(repairTimeoutRef.current);
            repairTimeoutRef.current = null;
        }
    }, []);

    if (syncPreparedMarkdown != null) return syncPreparedMarkdown;
    if (preparedState != null) {
        return markdown.startsWith(preparedState.sourceMarkdown)
            ? preparedState.preparedMarkdown
            : markdown;
    }
    const lastSyncPrepared = lastSyncPreparedRef.current;
    if (lastSyncPrepared != null && markdown.startsWith(lastSyncPrepared.sourceMarkdown)) {
        return lastSyncPrepared.preparedMarkdown;
    }
    return markdown;
}

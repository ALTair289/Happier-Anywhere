import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const markdownParseState = vi.hoisted(() => ({
    splitCalls: [] as unknown[],
}));

vi.mock('./rendering/splitMarkdownRenderSegments', () => ({
    splitMarkdownRenderSegments: (params: unknown) => {
        markdownParseState.splitCalls.push(params);
        return [{
            type: 'enriched-markdown',
            key: 'segment:0',
            sourceStart: 0,
            sourceLength: 5,
            sourceHash: 'hash',
            sourceRange: { startLine: 1, endLine: 1 },
            markdown: 'hello',
            first: true,
            last: true,
        }];
    },
}));

vi.mock('./enriched/EnrichedMarkdownTextAdapter', () => ({
    EnrichedMarkdownTextAdapter: (props: Record<string, unknown>) =>
        React.createElement('EnrichedMarkdownTextAdapter', props),
}));

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

describe('MarkdownView streaming parse cache', () => {
    afterEach(() => {
        standardCleanup();
        markdownParseState.splitCalls = [];
    });

    it('reuses parsed streaming segments across remounts for the same message revision key', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const props = {
            markdown: 'hello',
            streamingMode: 'streaming',
            streamingParseCacheKey: 'message:m1:revision:7',
        } as const;

        const first = await renderScreen(
            React.createElement(React.Fragment, { key: 'mount-1' }, React.createElement(MarkdownView, props as any)),
        );
        expect(markdownParseState.splitCalls).toHaveLength(1);

        await first.update(
            React.createElement(React.Fragment, { key: 'mount-2' }, React.createElement(MarkdownView, props as any)),
        );

        expect(markdownParseState.splitCalls).toHaveLength(1);
    });
});

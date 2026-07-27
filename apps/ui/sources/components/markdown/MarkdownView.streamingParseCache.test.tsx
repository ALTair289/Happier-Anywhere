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
    splitMarkdownRenderSegments: (params: { markdown: string }) => {
        markdownParseState.splitCalls.push(params);
        return [{
            type: 'enriched-markdown',
            key: 'segment:0',
            sourceStart: 0,
            sourceLength: params.markdown.length,
            sourceHash: 'hash',
            sourceRange: { startLine: 1, endLine: 1 },
            markdown: params.markdown,
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

    it('never reuses an earlier paced frame when prepared content changes under one revision key', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const common = {
            profile: 'transcript',
            streamingMode: 'streaming',
            streamingParseCacheKey: 'message:m-paced:revision:7',
        } as const;

        const screen = await renderScreen(
            <MarkdownView {...common} markdown="Hello" />,
        );
        expect(screen.findByType('EnrichedMarkdownTextAdapter').props.markdown).toBe('Hello');

        await screen.update(
            <MarkdownView {...common} markdown="Hello paced world" />,
        );
        expect(screen.findByType('EnrichedMarkdownTextAdapter').props.markdown).toBe('Hello paced world');

        await screen.update(
            <MarkdownView {...common} markdown="Hello rewrite" />,
        );
        expect(screen.findByType('EnrichedMarkdownTextAdapter').props.markdown).toBe('Hello rewrite');
        expect(markdownParseState.splitCalls).toHaveLength(3);
    });
});

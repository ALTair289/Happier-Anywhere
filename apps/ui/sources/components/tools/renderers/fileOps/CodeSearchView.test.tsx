import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { collectHostText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('CodeSearchView', () => {
    it('shows a compact subset of matches by default', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');

        const matches = Array.from({ length: 10 }, (_, i) => ({
            filePath: `/repo/file-${i}.ts`,
            line: i + 1,
            excerpt: `match-${i}`,
        }));
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'test' },
            result: { matches },
        });

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;

        const renderedText = collectHostText(tree);
        const normalized = renderedText.join(' ').replace(/\s+/g, ' ');
        expect(normalized).toContain('/repo/file-0.ts:1');
        expect(normalized).toContain('match-0');
        expect(normalized).toContain('/repo/file-5.ts:6');
        expect(normalized).toContain('match-5');
        expect(normalized).not.toContain('/repo/file-6.ts:7');
        expect(normalized).toContain('+4 more');
    });

    it('expands to show more matches when detailLevel=full', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');

        const matches = Array.from({ length: 10 }, (_, i) => ({
            filePath: `/repo/file-${i}.ts`,
            line: i + 1,
            excerpt: `match-${i}`,
        }));
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'test' },
            result: { matches },
        });

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool, { detailLevel: 'full' })))).tree;

        const renderedText = collectHostText(tree).join(' ').replace(/\s+/g, ' ');
        expect(renderedText).toContain('/repo/file-0.ts:1');
        expect(renderedText).toContain('match-0');
        expect(renderedText).toContain('/repo/file-9.ts:10');
        expect(renderedText).toContain('match-9');
        expect(renderedText).not.toContain('+4 more');
    });

    it('renders aggregate-only counts honestly and preserves truncation state', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'needle' },
            result: { matches: [], totalMatches: 4, detailsUnavailable: true, truncated: true },
        });

        const tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;
        const renderedText = collectHostText(tree).join(' ').replace(/\s+/g, ' ');
        expect(renderedText).toContain('4 matches; details were not provided.');
        expect(renderedText).toContain('Results may be truncated.');
        expect(renderedText).not.toContain('0 matches');
    });

    it('uses singular aggregate copy for exactly one unavailable match', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'needle' },
            result: { matches: [], totalMatches: 1, detailsUnavailable: true },
        });

        const tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;
        const renderedText = collectHostText(tree).join(' ').replace(/\s+/g, ' ');
        expect(renderedText).toContain('1 match; details were not provided.');
        expect(renderedText).not.toContain('1 matches');
    });

    it('renders an explicit empty state for a source-real zero-match result', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'definitely-absent-token' },
            result: { matches: [], totalMatches: 0 },
        });

        const tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;
        expect(collectHostText(tree).join(' ').replace(/\s+/g, ' ')).toContain('No matches');
    });

    it('does not contradict detailed matches with a malformed zero aggregate', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'needle' },
            result: {
                matches: [{ filePath: '/repo/a.ts', line: 1, excerpt: 'needle' }],
                totalMatches: 0,
            },
        });

        const tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;
        const renderedText = collectHostText(tree).join(' ').replace(/\s+/g, ' ');
        expect(renderedText).toContain('/repo/a.ts:1');
        expect(renderedText).not.toContain('No matches');
    });

    it('renders detailed truncation without an aggregate-unavailable claim', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'needle' },
            result: {
                matches: [{ filePath: '/repo/a.ts', line: 1, excerpt: 'needle' }],
                totalMatches: 1,
                truncated: true,
            },
        });

        const tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;
        const renderedText = collectHostText(tree).join(' ').replace(/\s+/g, ' ');
        expect(renderedText).toContain('/repo/a.ts:1');
        expect(renderedText).toContain('Results may be truncated.');
        expect(renderedText).not.toContain('details were not provided');
    });

    it('does not render a success summary for malformed truncation-only output', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'needle' },
            result: { truncated: true },
        });
        const tree = (await renderScreen(React.createElement(CodeSearchView, makeToolViewProps(tool)))).tree;
        expect(collectHostText(tree)).toEqual([]);
    });
});

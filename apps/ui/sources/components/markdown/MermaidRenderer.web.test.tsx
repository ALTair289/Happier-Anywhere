// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mermaidMocks = vi.hoisted(() => ({
    initialize: vi.fn(),
    render: vi.fn(),
}));

vi.mock('mermaid', () => ({
    default: mermaidMocks,
}));
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

installMarkdownCommonModuleMocks();

describe('MermaidRenderer web boundary', () => {
    beforeEach(() => {
        mermaidMocks.initialize.mockClear();
        mermaidMocks.render.mockReset();
    });

    it('dynamically renders and sanitizes Mermaid SVG', async () => {
        mermaidMocks.render.mockResolvedValue({
            svg: '<svg onclick="evil()"><script>evil()</script><text>safe</text></svg>',
        });
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(<MermaidRenderer content="graph TD; A-->B" />);
        try {
            const host = screen.find(node => typeof node.props.dangerouslySetInnerHTML?.__html === 'string');
            expect(host.props.dangerouslySetInnerHTML.__html).toBe('<svg><text>safe</text></svg>');
            expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'graph TD; A-->B');
        } finally {
            await screen.unmount();
        }
    });

    it('falls back to the source when Mermaid rendering fails', async () => {
        mermaidMocks.render.mockRejectedValue(new Error('invalid diagram'));
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(<MermaidRenderer content="not a diagram" />);
        try {
            expect(screen.findByTestId('mermaid-render-error')).not.toBeNull();
            expect(screen.findByTestId('mermaid-error-source')?.props.children).toBe('not a diagram');
        } finally {
            await screen.unmount();
        }
    });
});

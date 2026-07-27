// @vitest-environment jsdom

import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';
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

    it('reports terminality only after the SVG commit', async () => {
        let resolveRender!: (value: { svg: string }) => void;
        mermaidMocks.render.mockImplementation(() => new Promise((resolve) => {
            resolveRender = resolve;
        }));
        const handle = {
            complete: vi.fn(),
            dispose: vi.fn(),
        };
        const registerProducer = vi.fn(() => handle);
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer,
            }}>
                <MermaidRenderer content="graph TD; A-->B" />
            </InitialPresentationReadinessProvider>,
        );
        try {
            expect(registerProducer).toHaveBeenCalledTimes(1);
            expect(handle.complete).not.toHaveBeenCalled();

            await act(async () => {
                resolveRender({ svg: '<svg><text>settled</text></svg>' });
                await Promise.resolve();
            });

            expect(
                screen.find(node => typeof node.props.dangerouslySetInnerHTML?.__html === 'string')
                    .props.dangerouslySetInnerHTML.__html,
            ).toContain('settled');
            expect(handle.complete).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
        }
    });

    it('falls back to the source when Mermaid rendering fails', async () => {
        mermaidMocks.render.mockRejectedValue(new Error('invalid diagram'));
        const handle = {
            complete: vi.fn(),
            dispose: vi.fn(),
        };
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer: () => handle,
            }}>
                <MermaidRenderer content="not a diagram" />
            </InitialPresentationReadinessProvider>,
        );
        try {
            expect(screen.findByTestId('mermaid-render-error')).not.toBeNull();
            expect(screen.findByTestId('mermaid-error-source')?.props.children).toBe('not a diagram');
            expect(handle.complete).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
        }
    });
});

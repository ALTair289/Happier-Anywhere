import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'summary';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'permissionPromptSurface') return 'transcript';
                    return null;
                },
            },
        }),
    text: async () =>
        (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
            translate: (key) => key,
        }),
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

describe('ToolView header pin reveal', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('reveals a hidden header pin when keyboard focus reaches it, before it can be activated', async () => {
        const { ToolView } = await import('./ToolView');
        const onPinPress = vi.fn();

        const tool = makeToolCall({
            id: 't1',
            name: 'mcp__playwright__browser_close',
            state: 'completed',
            input: {},
            result: { ok: true },
        });

        const screen = await renderScreen(
            <ToolView
                tool={tool}
                metadata={null}
                messages={[]}
                sessionId="s1"
                messageId="m1"
                headerAction={{
                    node: React.createElement('Pressable', { testID: 'tool-view-pin', onPress: onPinPress }),
                    pinned: false,
                }}
            />,
        );

        const slot = () => screen.findByTestId('tool-view-header-reveal-slot');
        expect(readOpacity(slot()?.props.style)).toBe(0);
        expect(screen.findByTestId('tool-view-pin')).toBeTruthy();

        // Tabbing to the pin must reveal it: an Enter/Space activation of an
        // invisible button is the exact hazard the reveal slot exists to prevent.
        await act(async () => {
            slot()?.props.onFocus?.();
        });

        expect(readOpacity(slot()?.props.style)).toBe(1);
        expect(flattenStyle(slot()?.props.style).pointerEvents).toBe('auto');

        await act(async () => {
            screen.findByTestId('tool-view-pin')?.props.onPress?.();
        });

        expect(onPinPress).toHaveBeenCalledTimes(1);
    });
});

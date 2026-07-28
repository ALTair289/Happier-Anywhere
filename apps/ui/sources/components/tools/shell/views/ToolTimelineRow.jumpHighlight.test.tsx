import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let settings: Record<string, unknown> = {};

installToolShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => settings[key],
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    TextSelectabilityScope: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('TextSelectabilityScope', props, props.children),
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/tools/catalog', () => ({ knownTools: {} }));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => () => React.createElement('SpecificToolView'),
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: Record<string, unknown>) => React.createElement('CodeView', props),
}));

vi.mock('@/components/tools/shell/presentation/ToolHeaderActionsContext', () => ({
    ToolHeaderActionsContext: { Provider: ({ children }: React.PropsWithChildren) => children },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView'),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
    ToolError: () => React.createElement('ToolError'),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: React.PropsWithChildren<{ expanded: boolean }>) =>
        React.createElement('TranscriptCollapsible', { expanded }, expanded ? children : null),
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

async function renderToolTimelineRow(overrides: Record<string, unknown> = {}) {
    const { ToolTimelineRow } = await import('./ToolTimelineRow');
    const tool = {
        id: 'call-1',
        name: 'read',
        state: 'completed',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        result: {},
    } as never;

    return renderScreen(<ToolTimelineRow tool={tool} metadata={null} {...overrides} />);
}

describe('ToolTimelineRow jump landing highlight', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        settings = {
            toolViewDetailLevelDefault: 'title',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'summary',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
            permissionPromptSurface: 'transcript',
        };
    });

    afterEach(async () => {
        const { clearTranscriptJumpHighlight } =
            await import('@/components/sessions/transcript/navigation/transcriptJumpHighlightStore');
        await act(async () => {
            clearTranscriptJumpHighlight();
        });
        vi.useRealTimers();
        standardCleanup();
    });

    it('highlights a plain activity-feed tool row that never mounts MessageView', async () => {
        const { applyTranscriptJumpHighlightForJumpResult } =
            await import('@/components/sessions/transcript/navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } =
            await import('@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay');

        const screen = await renderToolTimelineRow({ sessionId: 's1', messageId: 'tool:call-1', jumpHighlightSeq: 4 });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'tool:call-1', seqHint: 4 },
            });
        });

        expect(
            screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID).filter((node) => typeof node.type === 'string'),
        ).toHaveLength(1);
    });

    it('does not highlight a row that is not the jump target', async () => {
        const { applyTranscriptJumpHighlightForJumpResult } =
            await import('@/components/sessions/transcript/navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } =
            await import('@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay');

        const screen = await renderToolTimelineRow({ sessionId: 's1', messageId: 'tool:call-1' });

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'tool:other-call' },
            });
        });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);
    });
});

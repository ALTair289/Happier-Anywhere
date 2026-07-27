import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostState = vi.hoisted(() => ({
    armVisibleAnchorHold: vi.fn(() => {
        hostState.events.push('prepare');
    }),
    events: [] as string[],
    messageViewProps: [] as Array<Record<string, any>>,
    toolGroupProps: [] as Array<Record<string, any>>,
}));

installTranscriptCommonModuleMocks();

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptFlashListEstimatedItemSize: 120,
            transcriptLegendListSpikeSurface: 'off',
            transcriptOlderLoadCooldownMs: 2500,
            transcriptOlderLoadSpinnerDelayMs: 0,
        }),
    },
}));

vi.mock('@/components/sessions/transcript/viewport/shell/TranscriptListShell', async () => {
    const ReactModule = await import('react');
    const TranscriptListShell = ReactModule.forwardRef((props: any, ref: React.ForwardedRef<any>) => {
        ReactModule.useImperativeHandle(ref, () => ({
            armVisibleAnchorHold: hostState.armVisibleAnchorHold,
            transcriptViewportCommandSpace: 'standard',
        }));
        return ReactModule.createElement(
            'TranscriptListShell',
            props,
            ...(Array.isArray(props.data)
                ? props.data.map((item: any, index: number) => ReactModule.createElement(
                    'TranscriptListItem',
                    { key: props.keyExtractor?.(item, index) ?? String(index) },
                    props.renderItem?.({ item, index }),
                ))
                : []),
        );
    });
    return { TranscriptListShell };
});

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageViewWithSessionCommon: (props: Record<string, any>) => {
        if (props.thinkingExpanded === true) {
            hostState.events.push('thinking-visible');
        }
        hostState.messageViewProps.push(props);
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRowWithSessionCommon: (props: Record<string, any>) => {
        if (props.expanded === true) {
            hostState.events.push('tool-visible');
        }
        hostState.toolGroupProps.push(props);
        return React.createElement('ToolCallsGroupRowWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow', () => ({
    ToolCallsGroupUnitHeaderRowWithSessionCommon: (props: Record<string, any>) => {
        if (props.expanded === true) {
            hostState.events.push('tool-visible');
        }
        hostState.toolGroupProps.push(props);
        return React.createElement('ToolCallsGroupUnitHeaderRowWithSessionCommon', props);
    },
}));

describe('ChainTranscriptList row-layout mutation ownership', () => {
    afterEach(() => {
        hostState.armVisibleAnchorHold.mockReset();
        hostState.events.length = 0;
        hostState.messageViewProps.length = 0;
        hostState.toolGroupProps.length = 0;
        standardCleanup();
    });

    it('arms the Legend renderer anchor before committing a thinking-height mutation', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        await renderScreen(
            <ChainTranscriptList
                sessionId="s1"
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={[
                    {
                        kind: 'agent-text',
                        id: 'thinking-1',
                        localId: null,
                        createdAt: 1,
                        text: 'Thinking',
                        isThinking: true,
                    },
                ]}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
            />,
        );

        const thinkingRow = hostState.messageViewProps.find((props) => props.message?.id === 'thinking-1');
        expect(thinkingRow?.onThinkingExpandedChange).toBeTypeOf('function');

        await act(async () => {
            thinkingRow?.onThinkingExpandedChange(true);
        });

        expect(hostState.armVisibleAnchorHold).toHaveBeenCalledTimes(1);
        expect(hostState.events).toEqual(['prepare', 'thinking-visible']);
    });

    it('arms the Legend renderer anchor before committing a tool-group visibility mutation', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        await renderScreen(
            <ChainTranscriptList
                sessionId="s1"
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={[
                    {
                        kind: 'tool-call',
                        id: 'tool-message-1',
                        localId: null,
                        createdAt: 1,
                        tool: {
                            id: 'tool-1',
                            name: 'Read',
                            state: 'completed',
                            input: { file: 'a.ts' },
                            result: 'a',
                            createdAt: 1,
                            startedAt: 1,
                            completedAt: 1,
                            description: null,
                        },
                        children: [],
                    },
                    {
                        kind: 'tool-call',
                        id: 'tool-message-2',
                        localId: null,
                        createdAt: 2,
                        tool: {
                            id: 'tool-2',
                            name: 'Read',
                            state: 'completed',
                            input: { file: 'b.ts' },
                            result: 'b',
                            createdAt: 2,
                            startedAt: 2,
                            completedAt: 2,
                            description: null,
                        },
                        children: [],
                    },
                ]}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
            />,
        );

        const toolGroup = hostState.toolGroupProps.at(-1);
        const setExpanded = toolGroup?.onSetExpanded ?? toolGroup?.setExpanded;
        expect(setExpanded).toBeTypeOf('function');

        await act(async () => {
            if (toolGroup?.onSetExpanded) {
                setExpanded({
                    toolCallsGroupId: toolGroup.toolCallsGroupId,
                    toolMessageIds: toolGroup.toolMessageIds,
                    expanded: true,
                });
            } else {
                setExpanded(true);
            }
        });

        expect(hostState.armVisibleAnchorHold).toHaveBeenCalledTimes(1);
        expect(hostState.events).toEqual(['prepare', 'tool-visible']);
    });
});

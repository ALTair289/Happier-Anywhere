import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import {
    createDeferred,
    flushHookEffects,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');
const loadOlderSidechainMessagesMock = vi.fn();
const toolTranscriptSyncTuning = vi.hoisted(() => ({
    transcriptFlashListEstimatedItemSize: 120,
    transcriptBackwardPrefetchThresholdPx: 40,
    transcriptOlderLoadCooldownMs: 0,
    transcriptOlderLoadSpinnerDelayMs: 0,
    transcriptLegendListSpikeSurface: 'off' as 'off' | 'flashList',
}));
const toolTranscriptLegendMock = vi.hoisted(() => ({
    state: null as null | {
        refHandle: {
            scrollToIndex: ReturnType<typeof vi.fn>;
        };
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
        loadOlderSidechainMessages: loadOlderSidechainMessagesMock,
        getSyncTuning: () => toolTranscriptSyncTuning,
    },
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: (props: any) => {
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function' ? props.ListFooterComponent() : props.ListFooterComponent)
                : null;

        return React.createElement(
            'FlashList',
            props,
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    },
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock();
    toolTranscriptLegendMock.state = mock.state;
    return mock.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

installToolShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Narrow boundary fixture: these tests only care about boolean local settings.
                useLocalSetting: (() => false) as any,
                useSetting: () => false,
            },
        });
    },
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

const renderedSpecificTaskViewSpy = vi.fn();
const renderedSpecificSubAgentRunViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: (toolName: string) => {
        if (toolName === 'Task' || toolName === 'SubAgent') {
            return (props: any) => {
                renderedSpecificTaskViewSpy(props);
                return React.createElement('TaskSpecificView', null);
            };
        }
        if (toolName === 'SubAgentRun') {
            return (props: any) => {
                renderedSpecificSubAgentRunViewSpy(props);
                return React.createElement('SubAgentRunSpecificView', null);
            };
        }
        return null;
    },
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Task: { title: 'Task' },
        SubAgent: { title: 'SubAgent' },
        SubAgentRun: { title: 'SubAgentRun' },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

const renderedMessageViewSpy = vi.fn();

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewSpy(props);
        return React.createElement('MessageView', null);
    },
    MessageViewWithSessionCommon: (props: any) => {
        renderedMessageViewSpy(props);
        return React.createElement('MessageViewWithSessionCommon', null);
    },
}));

describe('ToolFullView (Task transcript reuse)', () => {
    let ToolFullView: typeof import('./ToolFullView').ToolFullView;

    beforeAll(async () => {
        ({ ToolFullView } = await import('./ToolFullView'));
    }, 60000);

    beforeEach(() => {
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');
        loadOlderSidechainMessagesMock.mockReset();
        loadOlderSidechainMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });
        toolTranscriptSyncTuning.transcriptLegendListSpikeSurface = 'off';
        toolTranscriptLegendMock.state?.refHandle.scrollToIndex.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('ensures the sidechain transcript is loaded for Task tools', async () => {
        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });

        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'task-message-1',
                metadata: null,
                messages: [],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('shows a sidechain loading affordance while the full-view Task sidechain is in flight', async () => {
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('in_flight');
        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });

        const screen = await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'subagent-run-message-1',
                metadata: null,
                messages: [],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );
        await flushHookEffects();

        expect(screen.findByTestId('tool-fullview-sidechain-hydration-status')).not.toBeNull();
    });

    it('renders Task renderer as a header when Task transcript is empty (so the user still sees context)', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();

        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: { content: [{ type: 'text', text: 'Spawned successfully.' }] },
        });
        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'task-message-with-child',
                metadata: null,
                messages: [],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );
        await flushHookEffects();

        expect(renderedSpecificTaskViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                detailLevel: 'full',
            }),
        );
        expect(renderedMessageViewSpy).not.toHaveBeenCalled();
        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('ensures the sidechain transcript is loaded for SubAgentRun tools (prefers result.sidechainId when present)', async () => {
        const tool = makeToolCall({
            id: 'tool_subagent_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate', backendId: 'claude' },
            result: { sidechainId: 'sidechain_run_123' },
        });

        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'subagent-run-message-with-child',
                metadata: null,
                messages: [],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'sidechain_run_123');
    });

    it('renders Task sidechain messages through MessageView instead of Task renderer in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();

        const tool = makeToolCall({
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-1',
            localId: null,
            createdAt: 1000,
            text: 'Working...',
            isThinking: false,
        };
        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'agent-message-with-child',
                metadata: null,
                messages: [child],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );

        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificTaskViewSpy).not.toHaveBeenCalled();
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
    });

    it('isolates renderer, expansion, and jump state when switching id-less legacy tool messages in one session', async () => {
        const buildProps = (owningMessageId: string, text: string) => ({
            tool: makeToolCall({
                name: 'Task',
                input: { operation: 'run', description: text },
                result: null,
            }),
            owningMessageId,
            metadata: null,
            messages: [{
                kind: 'agent-text' as const,
                id: 'shared-thinking-message',
                localId: null,
                createdAt: 1000,
                text,
                isThinking: true,
            }],
            jumpChildId: 'shared-thinking-message',
            sessionId: 's1',
            interaction: { canSendMessages: true, canApprovePermissions: true },
        });

        const screen = await renderScreen(React.createElement(ToolFullView, buildProps('owner-a', 'sidechain A')));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const sidechainAList = screen.findByType('LegendList' as any);
        expect(sidechainAList.props.dataKey).toBe(JSON.stringify(['s1', 'owner-a']));
        expect(sidechainAList.props.data.map((item: { id: string }) => item.id)).toEqual(['msg:shared-thinking-message']);
        expect(toolTranscriptLegendMock.state?.refHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
            animated: true,
            index: 0,
        }));

        const sidechainAThinking = renderedMessageViewSpy.mock.calls
            .map(([props]) => props)
            .slice()
            .reverse()
            .find((props: any) => props.message?.text === 'sidechain A');
        expect(sidechainAThinking?.thinkingExpanded).toBe(false);
        await act(async () => {
            sidechainAThinking?.onThinkingExpandedChange(true);
            await flushHookEffects({ cycles: 2, turns: 2 });
        });
        expect(renderedMessageViewSpy.mock.calls
            .map(([props]) => props)
            .slice()
            .reverse()
            .find((props: any) => props.message?.text === 'sidechain A')?.thinkingExpanded).toBe(true);

        toolTranscriptLegendMock.state?.refHandle.scrollToIndex.mockClear();
        await act(async () => {
            await screen.update(React.createElement(ToolFullView, buildProps('owner-b', 'sidechain B')));
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        const sidechainBList = screen.findByType('LegendList' as any);
        expect(sidechainBList.props.dataKey).toBe(JSON.stringify(['s1', 'owner-b']));
        expect(sidechainBList.props.data.map((item: { id: string }) => item.id)).toEqual(['msg:shared-thinking-message']);
        expect(renderedMessageViewSpy.mock.calls
            .map(([props]) => props)
            .slice()
            .reverse()
            .find((props: any) => props.message?.text === 'sidechain B')?.thinkingExpanded).toBe(false);
        expect(toolTranscriptLegendMock.state?.refHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
            animated: true,
            index: 0,
        }));
    });

    it('isolates dirty pagination state and late completions when switching resolved sidechains in one session', async () => {
        toolTranscriptSyncTuning.transcriptLegendListSpikeSurface = 'flashList';
        const sidechainADeferred = createDeferred<{
            loaded: number;
            hasMore: boolean;
            status: 'loaded';
        }>();
        loadOlderSidechainMessagesMock.mockImplementation(async (_sessionId: string, sidechainId: string) => {
            if (sidechainId === 'sidechain-a') {
                return await sidechainADeferred.promise;
            }
            return { loaded: 0, hasMore: false, status: 'no_more' as const };
        });
        const buildProps = (sidechainId: string, messageId: string) => ({
            tool: makeToolCall({
                id: sidechainId,
                name: 'Task',
                input: { operation: 'run', description: sidechainId },
                result: null,
            }),
            metadata: null,
            messages: [{
                kind: 'agent-text' as const,
                id: messageId,
                localId: null,
                createdAt: 1000,
                text: messageId,
                isThinking: false,
            }],
            owningMessageId: `${sidechainId}-owner`,
            sessionId: 's1',
            interaction: { canSendMessages: true, canApprovePermissions: true },
        });
        const observeNearOlderEdge = async (list: ReactTestInstance) => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 20 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
        };

        const screen = await renderScreen(React.createElement(ToolFullView, buildProps('sidechain-a', 'a-message')));
        const sidechainAList = screen.findByType('FlashList' as any);
        await act(async () => {
            await observeNearOlderEdge(sidechainAList);
        });

        expect(loadOlderSidechainMessagesMock).toHaveBeenCalledWith('s1', 'sidechain-a');
        expect(screen.findAllByProps({ testID: 'transcript-older-load-progress-overlay' })).not.toHaveLength(0);

        await act(async () => {
            await screen.update(React.createElement(ToolFullView, buildProps('sidechain-b', 'b-message')));
            await flushHookEffects({ cycles: 2, turns: 2 });
        });
        const sidechainBList = screen.findByType('FlashList' as any);

        expect(sidechainBList.props.data.map((item: { id: string }) => item.id)).toEqual(['msg:b-message']);
        expect(screen.findAllByProps({ testID: 'transcript-older-load-progress-overlay' })).toHaveLength(0);

        await act(async () => {
            await observeNearOlderEdge(sidechainBList);
        });
        expect(loadOlderSidechainMessagesMock).toHaveBeenCalledWith('s1', 'sidechain-b');
        expect(loadOlderSidechainMessagesMock.mock.calls.filter((call) => call[1] === 'sidechain-b')).toHaveLength(1);

        await act(async () => {
            sidechainADeferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        const currentSidechainBList = screen.findByType('FlashList' as any);
        expect(currentSidechainBList.props.data.map((item: { id: string }) => item.id)).toEqual(['msg:b-message']);
        expect(screen.findAllByProps({ testID: 'transcript-older-load-progress-overlay' })).toHaveLength(0);

        await act(async () => {
            currentSidechainBList.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 200 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            currentSidechainBList.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 20 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
        });
        expect(loadOlderSidechainMessagesMock.mock.calls.filter((call) => call[1] === 'sidechain-b')).toHaveLength(1);
    });

    it('renders SubAgentRun sidechain messages through MessageView instead of SubAgentRun renderer in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();

        const tool = makeToolCall({
            name: 'SubAgentRun',
            input: { intent: 'review', backendId: 'claude' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-2',
            localId: null,
            createdAt: 1001,
            text: 'Streaming...',
            isThinking: false,
        };
        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'subagent-run-message-with-child',
                metadata: null,
                messages: [child],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );

        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
    });

    it('renders Agent sidechain messages through MessageView in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();

        const tool = makeToolCall({
            name: 'Agent',
            input: { name: 'Alpha', team_name: 'probe' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-3',
            localId: null,
            createdAt: 1002,
            text: 'From Alpha: hello',
            isThinking: false,
        };
        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'agent-message-with-child',
                metadata: null,
                messages: [child],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );

        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificTaskViewSpy).not.toHaveBeenCalled();
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
    });

    // The sidechain transcript rendered by ToolFullView is a *transcript surface*: its rows read the
    // same six-grant `TranscriptInteraction` contract as the main transcript. `MessageView` consumes
    // `canFork` / `canOpenFiles` / `canPreviewMedia` with exact-`true` checks, so any grant ToolFullView
    // fails to transport silently removes the affordance from the sidechain surface.
    const readSidechainInteraction = () => {
        const calls = renderedMessageViewSpy.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        return calls[calls.length - 1][0].interaction;
    };

    it('offers granted fork/open-file/media-preview affordances on the sidechain transcript surface', async () => {
        renderedMessageViewSpy.mockReset();
        const granted = deriveTranscriptInteraction({
            kind: 'session',
            accessLevel: null,
            canApprovePermissions: true,
            isSessionActive: true,
        });
        expect(granted.canFork).toBe(true);
        expect(granted.canOpenFiles).toBe(true);
        expect(granted.canPreviewMedia).toBe(true);

        await renderScreen(
            React.createElement(ToolFullView, {
                tool: makeToolCall({
                    id: 'tool_task_grants',
                    name: 'Task',
                    input: { operation: 'run', description: 'Explore' },
                    result: null,
                }),
                owningMessageId: 'task-message-grants',
                metadata: null,
                messages: [{
                    kind: 'agent-text' as const,
                    id: 'granted-child',
                    localId: null,
                    createdAt: 1000,
                    text: 'Working...',
                    isThinking: false,
                }],
                sessionId: 's1',
                interaction: granted,
            }),
        );
        await flushHookEffects();

        const delivered = readSidechainInteraction();
        // Exactly the checks `MessageView` performs (`=== true`).
        expect(delivered.canFork === true).toBe(true);
        expect(delivered.canOpenFiles === true).toBe(true);
        expect(delivered.canPreviewMedia === true).toBe(true);
        expect(delivered.canSendMessages === true).toBe(true);
        expect(delivered.canApprovePermissions === true).toBe(true);
        // ToolFullView still owns tool navigation suppression on its own surface.
        expect(delivered.disableToolNavigation).toBe(true);
    });

    it('keeps denied fork/open-file/media-preview affordances denied on the sidechain transcript surface', async () => {
        renderedMessageViewSpy.mockReset();
        const denied = deriveTranscriptInteraction({ kind: 'public' });

        await renderScreen(
            React.createElement(ToolFullView, {
                tool: makeToolCall({
                    id: 'tool_task_denied',
                    name: 'Task',
                    input: { operation: 'run', description: 'Explore' },
                    result: null,
                }),
                owningMessageId: 'task-message-denied',
                metadata: null,
                messages: [{
                    kind: 'agent-text' as const,
                    id: 'denied-child',
                    localId: null,
                    createdAt: 1000,
                    text: 'Working...',
                    isThinking: false,
                }],
                sessionId: 's1',
                interaction: denied,
            }),
        );
        await flushHookEffects();

        const delivered = readSidechainInteraction();
        expect(delivered.canFork).toBe(false);
        expect(delivered.canOpenFiles).toBe(false);
        expect(delivered.canPreviewMedia).toBe(false);
        expect(delivered.canSendMessages).toBe(false);
        expect(delivered.canApprovePermissions).toBe(false);
        expect(delivered.permissionDisabledReason).toBe('public');
        expect(delivered.disableToolNavigation).toBe(true);
    });

    it('renders Agent tools through the Task renderer header when the sidechain transcript is still empty', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();

        const tool = makeToolCall({
            id: 'tool_agent_1',
            name: 'Agent',
            input: { name: 'Alpha', team_name: 'probe', description: 'Inspect repo, report one fact' },
            result: { content: [{ type: 'text', text: 'Spawned successfully.' }] },
        });
        await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                owningMessageId: 'agent-empty-message',
                metadata: { flavor: 'claude' } as any,
                messages: [],
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }),
        );
        await flushHookEffects();

        expect(renderedSpecificTaskViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                detailLevel: 'full',
            }),
        );
        expect(renderedMessageViewSpy).not.toHaveBeenCalled();
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_agent_1');
    });
});

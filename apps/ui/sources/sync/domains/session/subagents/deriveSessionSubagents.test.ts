import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import { deriveSessionSubagents } from './deriveSessionSubagents';

function createToolMessage(params: {
    id: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    seq?: number;
    input?: any;
    result?: any;
    toolExtras?: Record<string, unknown>;
    messageExtras?: Record<string, unknown>;
}): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        ...(params.messageExtras ?? {}),
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: now,
        tool: {
            name: params.name,
            state: params.state,
            input: params.input ?? {},
            createdAt: now,
            startedAt: now,
            completedAt: params.state === 'running' ? null : now + 1,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
            ...(params.toolExtras ?? {}),
        },
        children: [],
    };
}

function createUserTextMessage(params: { id: string; text: string; seq?: number; meta?: MessageMeta }): Message {
    return {
        kind: 'user-text',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: Date.now(),
        text: params.text,
        ...(params.meta ? { meta: params.meta } : {}),
    } as Message;
}

function deriveSubagents(params: {
    session: any;
    messages: readonly Message[];
    activeExecutionRuns?: readonly { runId: string; status?: string | null }[];
}) {
    return deriveSessionSubagents(params);
}

describe('deriveSessionSubagents', () => {
    it('derives running execution run subagents with control capabilities', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_run_1',
                    name: 'SubAgentRun',
                    state: 'running',
                    input: { runId: 'run_1', label: 'Reviewer A' },
                    result: { sidechainId: 'subagent_run_1' },
                    toolExtras: { id: 'tool_subagent_run_1' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'execution_run:run_1',
                    kind: 'execution_run',
                    status: 'running',
                    display: expect.objectContaining({ title: 'Reviewer A' }),
                    transcript: expect.objectContaining({
                        sidechainId: 'subagent_run_1',
                        toolMessageRouteId: 'message_run_1',
                        toolId: 'tool_subagent_run_1',
                    }),
                    recipient: expect.objectContaining({ kind: 'execution_run', runId: 'run_1' }),
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: true,
                        canStop: true,
                        canOpenAdvancedRun: true,
                    }),
                }),
            ]),
        );
    });

    it('derives claude teammate subagents with sidechain routing and send capability', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    kind: 'agent_team_member',
                    status: 'running',
                    display: expect.objectContaining({
                        title: 'alpha',
                        groupKey: 'probe',
                        groupLabel: 'probe',
                    }),
                    transcript: expect.objectContaining({
                        sidechainId: 'tool_task_alpha',
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                    }),
                    recipient: expect.objectContaining({
                        kind: 'agent_team_member',
                        teamId: 'probe',
                        memberId: 'alpha@probe',
                    }),
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: true,
                        canDelete: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps a newly launched Claude teammate visible from subagent_launch.v1 meta even after the session already has team tool history', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                    result: { ok: true },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'completed',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
                createUserTextMessage({
                    id: 'message_member_launch',
                    text: 'Launch teammate gamma',
                    meta: {
                        happier: {
                            kind: 'subagent_launch.v1',
                            payload: {
                                kind: 'agent_team_member_create',
                                teamId: 'probe',
                                memberLabel: 'gamma',
                                instructions: 'Investigate gamma and reply.',
                                runInBackground: true,
                            },
                        },
                    },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:gamma@probe',
                    kind: 'agent_team_member',
                    status: 'running',
                    display: expect.objectContaining({
                        title: 'gamma',
                        groupKey: 'probe',
                    }),
                    recipient: expect.objectContaining({
                        kind: 'agent_team_member',
                        teamId: 'probe',
                        memberId: 'gamma@probe',
                        memberLabel: 'gamma',
                    }),
                    capabilities: expect.objectContaining({
                        canOpen: false,
                        canSend: true,
                        canDelete: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps the spawn tool route as the canonical full-open target for claude teammates', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
                createToolMessage({
                    id: 'message_agent_descendant',
                    name: 'Agent',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_agent_descendant' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                        sidechainId: 'tool_task_alpha',
                    }),
                }),
            ]),
        );
    });

    it('upgrades a claude teammate route from a descendant agent tool to the later spawn task route', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_agent_descendant',
                    name: 'Agent',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_agent_descendant' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                        sidechainId: 'tool_task_alpha',
                    }),
                }),
            ]),
        );
    });

    it('keeps the explicit spawn task route when later teammate task activity appears', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_spawn' },
                }),
                createToolMessage({
                    id: 'message_task_descendant',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha', prompt: 'follow-up work' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_descendant' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_spawn',
                        sidechainId: 'tool_task_spawn',
                    }),
                }),
            ]),
        );
    });

    it('derives generic SubAgent sidechains as monitor-only subagents when they are not execution runs or claude teammates', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'codex' } },
            messages: [
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'SubAgent',
                    state: 'running',
                    input: { prompt: 'Search the repo' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_generic' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_task_generic',
                    kind: 'subagent_sidechain',
                    status: 'running',
                    display: expect.objectContaining({
                        providerLabel: 'Codex',
                    }),
                    transcript: expect.objectContaining({
                        sidechainId: 'tool_task_generic',
                        toolMessageRouteId: 'tool:tool_task_generic',
                        toolId: 'tool_task_generic',
                    }),
                    recipient: null,
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: false,
                        canStop: false,
                        canDelete: false,
                    }),
                }),
            ]),
        );
    });

    it('derives provider-native completion-only SubAgent activity without fabricating a child transcript or controls', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_task',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        operation: 'run',
                        description: 'Inspect the integration',
                        prompt: 'Sanitized private prompt',
                        subagent_type: 'specialist',
                        model: 'cursor-model',
                        agent_id: 'cursor-agent-1',
                        duration_ms: 42,
                        _acp: { snapshotUpdatedAt: 10_000 },
                        _happier: {
                            v: 2,
                            protocol: 'acp',
                            provider: 'cursor',
                            rawToolName: 'Task',
                            canonicalToolName: 'SubAgent',
                            nativeSubagent: {
                                v: 1,
                                lifecycle: 'completion_only',
                                type: 'custom',
                                customType: 'specialist',
                                model: 'cursor-model',
                                agentId: 'cursor-agent-1',
                                durationMs: 42,
                            },
                        },
                    },
                    toolExtras: { id: 'opaque\ncursor-task-id ' },
                    messageExtras: { realID: 'server-cursor-task' },
                }),
            ],
        });

        expect(subagents).toEqual([
            expect.objectContaining({
                id: 'subagent_sidechain:opaque\ncursor-task-id ',
                kind: 'subagent_sidechain',
                status: 'succeeded',
                display: expect.objectContaining({
                    title: 'Inspect the integration',
                    subtitle: 'specialist · cursor-model',
                    providerLabel: 'Cursor',
                }),
                transcript: {
                    toolMessageRouteId: 'server:server-cursor-task',
                    toolId: 'opaque\ncursor-task-id ',
                },
                nativeRef: {
                    lifecycle: 'completion_only',
                    type: 'custom',
                    customType: 'specialist',
                    model: 'cursor-model',
                    agentId: 'cursor-agent-1',
                    durationMs: 42,
                },
                recipient: null,
                capabilities: {
                    canOpen: true,
                    canSend: false,
                    canStop: false,
                    canLaunchChild: false,
                    canDelete: false,
                    canOpenAdvancedRun: false,
                },
                timestamps: {
                    startedAtMs: 9_958,
                    updatedAtMs: 10_000,
                    finishedAtMs: 10_000,
                },
            }),
        ]);
        expect(subagents[0]?.transcript.sidechainId).toBeUndefined();
        expect(subagents[0]?.timestamps.startedAtMs).toBe(9_958);
    });

    it('renders a completion-only native task tombstoned without a result as cancelled rather than running', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_cancelled_task',
                    name: 'SubAgent',
                    state: 'running',
                    input: {
                        description: 'Cancelled native task',
                        _acp: { terminalWithoutResult: true },
                        _happier: {
                            nativeSubagent: {
                                v: 1,
                                lifecycle: 'completion_only',
                                type: 'browser',
                            },
                        },
                    },
                    toolExtras: { id: 'cancelled-cursor-task-id' },
                }),
            ],
        });

        expect(subagents).toEqual([
            expect.objectContaining({
                id: 'subagent_sidechain:cancelled-cursor-task-id',
                status: 'cancelled',
                transcript: expect.not.objectContaining({ sidechainId: expect.anything() }),
            }),
        ]);
    });

    it('fails closed on oversized or out-of-contract native task display metadata from durable history', async () => {
        const oversized = 'x'.repeat(513);
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_malformed_native_task',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        description: 'Bounded native task',
                        _happier: {
                            nativeSubagent: {
                                v: 1,
                                lifecycle: 'completion_only',
                                type: oversized,
                                model: oversized,
                                agentId: oversized,
                                durationMs: 2_592_000_001,
                            },
                        },
                    },
                    toolExtras: { id: 'malformed-native-task-id' },
                }),
            ],
        });

        expect(subagents).toEqual([
            expect.objectContaining({
                display: expect.not.objectContaining({ subtitle: expect.anything() }),
                nativeRef: { lifecycle: 'completion_only' },
                timestamps: expect.not.objectContaining({ startedAtMs: expect.anything() }),
            }),
        ]);
    });

    it('bounds completion-only titles and never promotes the private task prompt into the routine subagent list', async () => {
        const longDescription = `Visible description ${'x'.repeat(700)}`;
        const privatePrompt = 'PRIVATE_TASK_PROMPT_MUST_NOT_BECOME_A_LIST_TITLE';
        const nativeMarker = {
            nativeSubagent: {
                v: 1,
                lifecycle: 'completion_only',
                type: 'explore',
            },
        } as const;
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_long_description',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        description: longDescription,
                        prompt: privatePrompt,
                        _happier: nativeMarker,
                    },
                    toolExtras: { id: 'long-description-task' },
                }),
                createToolMessage({
                    id: 'message_cursor_prompt_only',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        prompt: privatePrompt,
                        _happier: nativeMarker,
                    },
                    toolExtras: { id: 'prompt-only-task' },
                }),
            ],
        });

        const longDescriptionTask = subagents.find((candidate) => candidate.transcript.toolId === 'long-description-task');
        const promptOnlyTask = subagents.find((candidate) => candidate.transcript.toolId === 'prompt-only-task');
        expect(longDescriptionTask?.display.title.startsWith('Visible description')).toBe(true);
        expect(longDescriptionTask?.display.title.length).toBeLessThanOrEqual(512);
        expect(longDescriptionTask?.display.title).not.toContain(privatePrompt);
        expect(promptOnlyTask?.display.title).toBe('SubAgent');
        expect(promptOnlyTask?.display.title).not.toContain(privatePrompt);
    });

    it('prefers a pending permission tool route for generic subagents until the provider sidechain can proceed', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'opencode' } },
            messages: [
                createToolMessage({
                    id: 'message_permission_generic',
                    name: 'task',
                    state: 'running',
                    input: {
                        permission: 'task',
                        patterns: ['general'],
                        always: ['*'],
                        metadata: {
                            description: 'Run pwd',
                            subagent_type: 'general',
                        },
                    },
                    toolExtras: {
                        id: 'per_subagent_1',
                        permission: {
                            id: 'per_subagent_1',
                            status: 'pending',
                            kind: 'permission',
                        },
                    },
                }),
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'SubAgent',
                    state: 'running',
                    input: {
                        description: 'Run pwd',
                        prompt: 'Use the Bash tool to run `pwd` and return the output.',
                        subagent_type: 'general',
                    },
                    result: { status: 'running' },
                    toolExtras: { id: 'call_subagent_1' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:call_subagent_1',
                    kind: 'subagent_sidechain',
                    transcript: expect.objectContaining({
                        sidechainId: 'call_subagent_1',
                        toolMessageRouteId: 'tool:per_subagent_1',
                        toolId: 'call_subagent_1',
                    }),
                }),
            ]),
        );
    });

    it('keeps legacy Task and Agent tool names compatible with generic subagent derivation', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'opencode' } },
            messages: [
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'Task',
                    state: 'running',
                    input: { prompt: 'Search the repo' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_generic' },
                }),
                createToolMessage({
                    id: 'message_agent_generic',
                    name: 'Agent',
                    state: 'completed',
                    input: { prompt: 'Summarize the repo' },
                    result: { status: 'completed' },
                    toolExtras: { id: 'tool_agent_generic' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_task_generic',
                    kind: 'subagent_sidechain',
                }),
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_agent_generic',
                    kind: 'subagent_sidechain',
                }),
            ]),
        );
    });

});

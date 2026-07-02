import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: loggerDebug,
        error: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
    },
}));

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import type { SessionRuntimeActivityPublisher } from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';

type Release = () => void;

function createQueryFromEvents(events: unknown[], holdOpen?: Promise<void>) {
    // Agent SDK tests use partial SDK payloads intentionally: the SDK is the external boundary here.
    return vi.fn((_params: unknown) => ({
        async *[Symbol.asyncIterator]() {
            for (const event of events) {
                yield event as any;
            }
            if (holdOpen) {
                await holdOpen;
            }
        },
        close: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        supportedCommands: vi.fn(async () => []),
        supportedModels: vi.fn(async () => []),
    } as any));
}

function createNextMessage() {
    let didSendFirst = false;
    return vi.fn(async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
    });
}

function createHoldOpen(): { promise: Promise<void>; release: Release } {
    let release: Release | null = null;
    return {
        promise: new Promise<void>((resolve) => {
            release = resolve;
        }),
        release: () => release?.(),
    };
}

function createRuntimeActivityPublisherHarness() {
    const calls: string[] = [];
    const publisher: SessionRuntimeActivityPublisher = {
        setSourceActive: vi.fn(async (input) => {
            calls.push(`active:${input.id}:${input.sourceClass}:${input.providerId ?? ''}`);
        }),
        observeSource: vi.fn(async (input) => {
            calls.push(`observe:${input.id}:${input.reason}`);
        }),
        observeAmbientLiveness: vi.fn(async (reason) => {
            calls.push(`ambient:${reason}`);
        }),
        clearSource: vi.fn(async (id, reason) => {
            calls.push(`clear:${id}:${reason}`);
        }),
        clearProviderSources: vi.fn(async (providerId, reason) => {
            calls.push(`clear-provider:${providerId}:${reason}`);
        }),
        clearAll: vi.fn(async (reason) => {
            calls.push(`clear-all:${reason}`);
        }),
        reconcileSources: vi.fn(async () => {}),
        getProjection: vi.fn(() => ({
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityExpiresAt: null,
            runtimeActivitySourceClass: null,
        })),
        getSnapshot: vi.fn(() => ({
            v: 1 as const,
            observedAtMs: 0,
            activeCount: 0,
            sources: [],
        })),
    };
    return { calls, publisher };
}

describe('claudeRemoteAgentSdk subagent turn completion', () => {
    beforeEach(() => {
        loggerDebug.mockClear();
    });

    it('keeps the parent turn in flight when a subagent task_notification completes', async () => {
        const holdOpen = createHoldOpen();
        const callOrder: string[] = [];
        const onReady = vi.fn(() => callOrder.push('ready'));
        const onSubagentFlush = vi.fn(() => callOrder.push('subagentFlush'));
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' },
        ], holdOpen.promise);

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        await vi.waitFor(() => {
            expect(onSubagentFlush).toHaveBeenCalledTimes(1);
        });

        expect(onReady).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['subagentFlush']);
        expect(thinkingEvents).toEqual([true]);

        holdOpen.release();
        await runnerPromise;
    });

    it('flushes subagents before emitting ready for the parent result', async () => {
        const callOrder: string[] = [];
        const onReady = vi.fn(() => callOrder.push('ready'));
        const onSubagentFlush = vi.fn(() => callOrder.push('subagentFlush'));

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([
                { type: 'system', subtype: 'task_started', task_id: 'task_1' },
                { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' },
                { type: 'system', subtype: 'task_started', task_id: 'task_2' },
                { type: 'system', subtype: 'task_notification', task_id: 'task_2', status: 'completed' },
                { type: 'result' },
            ]),
        } as any);

        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onSubagentFlush).toHaveBeenCalledTimes(2);
        expect(callOrder).toEqual(['subagentFlush', 'subagentFlush', 'ready']);
    });

    it('emits ready once for a parent result without subagents', async () => {
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([{ type: 'result' }]),
        } as any);

        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onSubagentFlush).not.toHaveBeenCalled();
    });

    it('releases a deferred parent result when a provider task notification reports succeeded', async () => {
        const holdOpen = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'succeeded' },
            { type: 'result' },
        ], holdOpen.promise);

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onSubagentFlush).toHaveBeenCalledTimes(1);
        } finally {
            holdOpen.release();
            await runnerPromise;
        }
    });

    it('releases a deferred parent result when a task_updated patch reports completion', async () => {
        const holdOpen = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            { type: 'result' },
            { type: 'system', subtype: 'task_updated', task_id: 'task_1', patch: { status: 'completed' } },
        ], holdOpen.promise);

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            holdOpen.release();
            await runnerPromise;
        }
    });

    it('does not keep a provider task active when the task event patch is already terminal', async () => {
        const holdOpen = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1', patch: { status: 'succeeded' } },
            { type: 'result' },
        ], holdOpen.promise);

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            holdOpen.release();
            await runnerPromise;
        }
    });

    it('completes the parent turn on result while a background task is still running', async () => {
        const releaseBackgroundTask = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                    },
                    tool_use_result: {
                        assistantAutoBackgrounded: true,
                        backgroundTaskId: 'task_1',
                        interrupted: false,
                        stderr: '',
                        stdout: '',
                    },
                } as any;
                yield { type: 'result' } as any;
                await releaseBackgroundTask.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseBackgroundTask.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(1);
            });
            expect(thinkingEvents).toEqual([true, false]);
            const resultSummary = loggerDebug.mock.calls
                .map((call) => call[1])
                .find((summary) => (
                    summary
                    && typeof summary === 'object'
                    && (summary as { resultObserved?: unknown }).resultObserved === true
                ));
            expect(resultSummary).toMatchObject({
                activeProviderTaskBlockers: [
                    {
                        taskId: 'task_1',
                        sources: expect.arrayContaining([
                            'system-task-started',
                            'assistant-auto-backgrounded-tool-result',
                        ]),
                    },
                ],
                activeProviderTaskCount: 1,
            });
            expect(resultSummary).not.toHaveProperty('deferredCompletionForActiveProviderTasks');

            releaseBackgroundTask.release();

            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            releaseBackgroundTask.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('accepts a follow-up prompt after result while a detached provider task remains active', async () => {
        const releaseBackgroundTask = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const onPromptAcceptedByProvider = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return {
                    message: 'initial',
                    mode: makeMode({ permissionMode: 'default' }),
                    maxUserMessageSeq: 1,
                    userMessageLocalIds: ['local-initial'],
                };
            }
            if (nextMessageCalls === 2) {
                return {
                    message: 'follow up',
                    mode: makeMode({ permissionMode: 'default' }),
                    maxUserMessageSeq: 2,
                    userMessageLocalIds: ['local-follow-up'],
                };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                    },
                    tool_use_result: {
                        assistantAutoBackgrounded: true,
                        backgroundTaskId: 'task_1',
                        interrupted: false,
                        stderr: '',
                        stdout: '',
                    },
                } as any;
                yield { type: 'result' } as any;
                await releaseBackgroundTask.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseBackgroundTask.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onPromptAcceptedByProvider,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
                    maxUserMessageSeq: 2,
                    userMessageLocalIds: ['local-follow-up'],
                });
            });
            expect(thinkingEvents).toEqual([true, false, true]);
        } finally {
            releaseBackgroundTask.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('interrupts an active follow-up foreground turn instead of a stale detached task target', async () => {
        const releaseBackgroundTask = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const onPromptAcceptedByProvider = vi.fn();
        const stopTask = vi.fn(async () => {
            releaseBackgroundTask.release();
            releaseClosed.release();
        });
        const interrupt = vi.fn(async () => {
            releaseBackgroundTask.release();
            releaseClosed.release();
        });
        let capturedTurnInterrupt: (() => Promise<void>) | null = null;
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return {
                    message: 'initial',
                    mode: makeMode({ permissionMode: 'default' }),
                    maxUserMessageSeq: 1,
                    userMessageLocalIds: ['local-initial'],
                };
            }
            if (nextMessageCalls === 2) {
                return {
                    message: 'follow up',
                    mode: makeMode({ permissionMode: 'default' }),
                    maxUserMessageSeq: 2,
                    userMessageLocalIds: ['local-follow-up'],
                };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                    },
                    tool_use_result: {
                        assistantAutoBackgrounded: true,
                        backgroundTaskId: 'task_1',
                        interrupted: false,
                        stderr: '',
                        stdout: '',
                    },
                } as any;
                yield { type: 'result' } as any;
                await releaseBackgroundTask.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseBackgroundTask.release();
                releaseClosed.release();
            }),
            interrupt,
            stopTask,
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSubagentFlush: () => {},
            onPromptAcceptedByProvider,
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (next: (() => Promise<void>) | null) => {
                capturedTurnInterrupt = next;
            },
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
                    maxUserMessageSeq: 2,
                    userMessageLocalIds: ['local-follow-up'],
                });
            });
            expect(capturedTurnInterrupt).toBeTypeOf('function');

            await (capturedTurnInterrupt as unknown as () => Promise<void>)();

            expect(interrupt).toHaveBeenCalledTimes(1);
            expect(stopTask).not.toHaveBeenCalled();
        } finally {
            releaseBackgroundTask.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('publishes detached provider task runtime activity across result and clears it on terminal notification', async () => {
        const releaseProgress = createHoldOpen();
        const releaseTerminal = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const runtimeActivity = createRuntimeActivityPublisherHarness();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                    },
                    tool_use_result: {
                        assistantAutoBackgrounded: true,
                        backgroundTaskId: 'task_1',
                    },
                } as any;
                yield { type: 'result' } as any;
                await releaseProgress.promise;
                yield { type: 'system', subtype: 'task_progress', task_id: 'task_1' } as any;
                await releaseTerminal.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseProgress.release();
                releaseTerminal.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            runtimeActivityPublisher: runtimeActivity.publisher,
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
                    id: 'claude:provider-task:task_1',
                    sourceClass: 'provider_detached_task',
                    providerId: 'claude',
                });
            });
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(1);
            });
            expect(thinkingEvents).toEqual([true, false]);
            expect(runtimeActivity.publisher.observeAmbientLiveness).not.toHaveBeenCalled();

            releaseProgress.release();
            await vi.waitFor(() => {
                expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
                    id: 'claude:provider-task:task_1',
                    sourceClass: 'provider_detached_task',
                    providerId: 'claude',
                });
            });

            releaseTerminal.release();
            await vi.waitFor(() => {
                expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
                    'claude:provider-task:task_1',
                    'claude_provider_task_terminal',
                );
            });
            expect(thinkingEvents).toEqual([true, false]);
        } finally {
            releaseProgress.release();
            releaseTerminal.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('publishes runtime activity when the first detached task evidence is progress after result', async () => {
        const releaseProgress = createHoldOpen();
        const releaseTerminal = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const runtimeActivity = createRuntimeActivityPublisherHarness();
        const onReady = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                await releaseProgress.promise;
                yield { type: 'system', subtype: 'task_progress', task_id: 'task_progress_first' } as any;
                yield { type: 'result' } as any;
                await releaseTerminal.promise;
                yield {
                    type: 'system',
                    subtype: 'task_notification',
                    task_id: 'task_progress_first',
                    status: 'completed',
                } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseProgress.release();
                releaseTerminal.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush: () => {},
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            runtimeActivityPublisher: runtimeActivity.publisher,
            createQuery,
        } as any);

        try {
            releaseProgress.release();
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(1);
            });
            expect(thinkingEvents).toEqual([true, false]);

            await vi.waitFor(() => {
                expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
                    id: 'claude:provider-task:task_progress_first',
                    sourceClass: 'provider_detached_task',
                    providerId: 'claude',
                });
            });
            expect(runtimeActivity.publisher.observeSource).not.toHaveBeenCalledWith({
                id: 'claude:provider-task:task_progress_first',
                reason: 'claude_provider_task_progress',
            });

            releaseTerminal.release();
            await vi.waitFor(() => {
                expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
                    'claude:provider-task:task_progress_first',
                    'claude_provider_task_terminal',
                );
            });
        } finally {
            releaseProgress.release();
            releaseTerminal.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('completes the parent turn on result for async_launched tool results that carry taskId', async () => {
        const releaseBackgroundTask = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Workflow launched' }],
                    },
                    toolUseResult: {
                        status: 'async_launched',
                        taskId: 'task_1',
                    },
                } as any;
                yield { type: 'result' } as any;
                await releaseBackgroundTask.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseBackgroundTask.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                const resultSummary = loggerDebug.mock.calls
                    .map((call) => call[1])
                    .find((summary) => (
                        summary
                        && typeof summary === 'object'
                        && (summary as { resultObserved?: unknown }).resultObserved === true
                    ));
                expect(resultSummary).toMatchObject({
                    activeProviderTaskBlockers: [
                        {
                            taskId: 'task_1',
                            sources: ['assistant-auto-backgrounded-tool-result'],
                        },
                    ],
                    activeProviderTaskCount: 1,
                });
                expect(resultSummary).not.toHaveProperty('deferredCompletionForActiveProviderTasks');
            });
            expect(thinkingEvents).toEqual([true, false]);

            releaseBackgroundTask.release();

            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            releaseBackgroundTask.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('does not reopen foreground lifecycle for a task notification observed after result', async () => {
        const releaseNotification = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'result' } as any;
                await releaseNotification.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_late', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseNotification.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });

            releaseNotification.release();

            await vi.waitFor(() => {
                expect(onSubagentFlush).toHaveBeenCalledTimes(1);
            });
            expect(thinkingEvents).toEqual([true, false]);
        } finally {
            releaseNotification.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('does not reopen foreground lifecycle for a provider task tool result observed after result', async () => {
        const releaseToolResult = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const runtimeActivity = createRuntimeActivityPublisherHarness();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'result' } as any;
                await releaseToolResult.promise;
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                    },
                    toolUseResult: {
                        status: 'async_launched',
                        taskId: 'task_after_result',
                    },
                } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseToolResult.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            runtimeActivityPublisher: runtimeActivity.publisher,
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });

            releaseToolResult.release();

            await vi.waitFor(() => {
                expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
                    id: 'claude:provider-task:task_after_result',
                    sourceClass: 'provider_detached_task',
                    providerId: 'claude',
                });
            });
            expect(thinkingEvents).toEqual([true, false]);
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            releaseToolResult.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it('rejects Agent SDK error result subtypes instead of completing the turn normally', async () => {
        const onReady = vi.fn();

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([
                { type: 'result', subtype: 'error_max_turns', result: 'maximum turns reached' },
            ]),
        } as any)).rejects.toThrow(/error_max_turns/);

        expect(onReady).not.toHaveBeenCalled();
    });

    it('keeps the latest active subagent interrupt target when an earlier subagent completes', async () => {
        const holdOpen = createHoldOpen();
        const stopTask = vi.fn(async () => {});
        let capturedTurnInterrupt: (() => Promise<void>) | null = null;

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield { type: 'system', subtype: 'task_started', task_id: 'task_2' } as any;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await holdOpen.promise;
            },
            stopTask,
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady: () => {},
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (next: (() => Promise<void>) | null) => {
                capturedTurnInterrupt = next;
            },
            createQuery,
        } as any);

        await vi.waitFor(() => {
            expect(capturedTurnInterrupt).toBeTypeOf('function');
        });

        await vi.waitFor(() => {
            expect(createQuery).toHaveBeenCalled();
        });

        await (capturedTurnInterrupt as unknown as () => Promise<void>)();
        expect(stopTask).toHaveBeenCalledWith('task_2');

        holdOpen.release();
        await runnerPromise;
    });

    it('keeps the latest active subagent interrupt target when an earlier task start event is already terminal', async () => {
        const holdOpen = createHoldOpen();
        const stopTask = vi.fn(async () => {});
        let capturedTurnInterrupt: (() => Promise<void>) | null = null;

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield { type: 'system', subtype: 'task_started', task_id: 'task_2' } as any;
                yield {
                    type: 'system',
                    subtype: 'task_started',
                    task_id: 'task_1',
                    patch: { status: 'succeeded' },
                } as any;
                await holdOpen.promise;
            },
            stopTask,
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady: () => {},
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (next: (() => Promise<void>) | null) => {
                capturedTurnInterrupt = next;
            },
            createQuery,
        } as any);

        await vi.waitFor(() => {
            expect(capturedTurnInterrupt).toBeTypeOf('function');
        });

        await vi.waitFor(() => {
            expect(createQuery).toHaveBeenCalled();
        });

        await (capturedTurnInterrupt as unknown as () => Promise<void>)();
        expect(stopTask).toHaveBeenCalledWith('task_2');

        holdOpen.release();
        await runnerPromise;
    });
});

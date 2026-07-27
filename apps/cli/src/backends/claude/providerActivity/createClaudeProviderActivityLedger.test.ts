import { describe, expect, it, vi } from 'vitest';
import {
    createClaudeProviderActivityLedger,
    normalizeClaudeProviderTaskEvent,
    readClaudeSessionHookProviderTaskActivity,
    readClaudeProviderTaskActivity,
} from './createClaudeProviderActivityLedger';

describe('Claude provider task lifecycle', () => {
    it('keeps strict activity admission separate from operational interrupt targets', () => {
        expect(normalizeClaudeProviderTaskEvent({
            type: 'user',
            toolUseResult: { status: 'async_launched', agentId: ' async-agent ' },
        })).toEqual({
            activity: null,
            interruptTarget: { type: 'active', taskId: 'async-agent' },
        });
        expect(normalizeClaudeProviderTaskEvent({
            type: 'system',
            subtype: 'task_started',
            task_id: ' task-without-session ',
        })).toEqual({
            activity: null,
            interruptTarget: { type: 'active', taskId: 'task-without-session' },
        });
        expect(normalizeClaudeProviderTaskEvent({
            type: 'system',
            subtype: 'task_notification',
            task_id: ' task-without-session ',
            status: 'completed',
        })).toEqual({
            activity: null,
            interruptTarget: { type: 'terminal', taskId: 'task-without-session' },
        });
        expect(readClaudeProviderTaskActivity({
            type: 'user',
            toolUseResult: { status: 'async_launched', agentId: 'async-agent' },
        })).toBeNull();
    });

    it('accepts only exact typed lifecycle rows and aliases explicit Workflow', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'system', subtype: 'task_started', session_id: ' s1 ', task_id: ' t1 ',
            task_type: 'local_workflow',
        })).toEqual({ type: 'started', sessionId: 's1', taskId: 't1' });
        expect(readClaudeProviderTaskActivity({
            type: 'system', subtype: 'task_progress', session_id: 's1', task_id: 't1',
        })).toEqual({ type: 'progress', sessionId: 's1', taskId: 't1' });
        for (const status of ['completed', 'failed', 'stopped']) {
            expect(readClaudeProviderTaskActivity({
                type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status,
            })).toEqual({ type: 'terminal', terminalStatus: status, sessionId: 's1', taskId: 't1' });
        }
        for (const [status, terminalStatus] of [
            ['completed', 'completed'],
            ['failed', 'failed'],
            ['killed', 'stopped'],
        ] as const) {
            expect(readClaudeProviderTaskActivity({
                type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status },
            })).toEqual({ type: 'terminal', terminalStatus, sessionId: 's1', taskId: 't1' });
        }
    });

    it('rejects inferred and broadened evidence', () => {
        expect(readClaudeProviderTaskActivity({ type: 'user', toolUseResult: { backgroundTaskId: 't1' } })).toBeNull();
        expect(readClaudeProviderTaskActivity({ type: 'queue-operation', content: '<task-notification />' })).toBeNull();
        expect(readClaudeProviderTaskActivity({ hook_event_name: 'Stop', background_tasks: [] })).toBeNull();
        expect(readClaudeProviderTaskActivity({
            type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status: 'succeeded',
        })).toBeNull();
        for (const status of ['pending', 'running', 'stopped', 'cancelled', 'succeeded']) {
            expect(readClaudeProviderTaskActivity({
                type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status },
            })).toBeNull();
        }
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_updated',
            session_id: 's1',
            task_id: 't1',
            status: 'completed',
        })).toBeNull();
    });

    it('keeps local/remote Agent typed starts and unknown progress non-admitting', () => {
        for (const taskType of ['local_agent', 'remote_agent', 'subagent', undefined]) {
            expect(readClaudeProviderTaskActivity({
                type: 'system',
                subtype: 'task_started',
                session_id: 's1',
                task_id: 'agent-1',
                task_type: taskType,
            })).toEqual({
                type: 'started',
                sessionId: 's1',
                taskId: 'agent-1',
                admission: 'known-only',
            });
        }
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_started',
            session_id: 's1',
            task_id: 'bash-1',
            task_type: 'local_bash',
        })).toEqual({ type: 'started', sessionId: 's1', taskId: 'bash-1' });
    });
});

describe('readClaudeSessionHookProviderTaskActivity', () => {
    const sessionId = 'claude-session-1';

    it('admits exact async/remote Agent launches without optional input/response hints', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_input: {},
            tool_response: { status: 'async_launched', agentId: ' local-agent ' },
        })).toEqual({ type: 'started', sessionId, taskId: 'local-agent' });
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_input: { run_in_background: false },
            tool_response: { status: 'async_launched', agentId: 'local-agent', isAsync: false },
        })).toEqual({ type: 'started', sessionId, taskId: 'local-agent' });
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_response: { status: 'remote_launched', taskId: ' remote-task ' },
        })).toEqual({ type: 'started', sessionId, taskId: 'remote-task' });
    });

    it('re-admits only a successful main-chain SendMessage resumed Agent id', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'SendMessage',
            tool_response: { success: true, resumedAgentId: ' resumed-1 ' },
        })).toEqual({ type: 'started', sessionId, taskId: 'resumed-1', source: 'hook-agent-resume' });
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'SendMessage',
            tool_response: { resumedAgentId: ' resumed-2 ' },
        })).toEqual({ type: 'started', sessionId, taskId: 'resumed-2', source: 'hook-agent-resume' });
        for (const toolResponse of [
            { success: false, resumedAgentId: 'resumed-1' },
            { is_error: true, resumedAgentId: 'resumed-1' },
            { isError: true, resumedAgentId: 'resumed-1' },
            { error: 'rejected', resumedAgentId: 'resumed-1' },
            ...['failed', 'error', 'denied', 'rejected'].map((status) => ({ status, resumedAgentId: 'resumed-1' })),
        ]) expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'SendMessage',
            tool_response: toolResponse,
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            agent_id: 'sidechain',
            tool_name: 'SendMessage',
            tool_response: { resumedAgentId: 'resumed-1' },
        })).toEqual({ type: 'progress', sessionId, taskId: 'sidechain' });
    });

    it('aliases exact async Workflow taskId admission without creating another owner', () => {
        const ledger = createClaudeProviderActivityLedger();
        for (const [status, taskId] of [
            ['async_launched', 'workflow-1'],
            ['remote_launched', 'workflow-2'],
        ] as const) {
            const activity = readClaudeSessionHookProviderTaskActivity({
                hook_event_name: 'PostToolUse',
                session_id: sessionId,
                tool_name: 'Workflow',
                tool_response: { status, taskId: ` ${taskId} ` },
            });
            expect(activity).toEqual({ type: 'started', sessionId, taskId });
            if (!activity) throw new Error('expected exact Workflow activity');
            expect(ledger.apply(activity)).toBe(true);
            expect(ledger.apply(activity)).toBe(false);
        }
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Workflow',
            tool_response: { status: 'async_launched', task_id: 'unproven-alias' },
        })).toBeNull();
    });

    it('keeps foreground, PreToolUse, and unknown SubagentStart evidence inert', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_response: { status: 'completed', agentId: 'foreground-agent' },
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_input: { run_in_background: true },
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStart',
            session_id: sessionId,
            agent_id: 'unknown-agent',
        })).toEqual({ type: 'progress', sessionId, taskId: 'unknown-agent' });
    });

    it('requires matching nested terminal TaskOutput evidence and terminal TaskStop confirmation', () => {
        const taskOutput = (toolResponse: unknown) => readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'TaskOutput',
            tool_input: { task_id: 'task-1' },
            tool_response: toolResponse,
        });
        expect(taskOutput({ retrieval_status: 'success', task: { task_id: 'task-1', status: 'running' } })).toBeNull();
        expect(taskOutput({ retrieval_status: 'success', task: { task_id: 'sibling', status: 'completed' } })).toBeNull();
        expect(taskOutput({ retrieval_status: 'success' })).toBeNull();
        for (const status of ['completed', 'failed', 'stopped', 'killed']) {
            expect(taskOutput({
                retrieval_status: 'success',
                task: { task_id: 'task-1', status },
            })).toEqual({ type: 'terminal', sessionId, taskId: 'task-1' });
        }

        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'TaskStop',
            tool_input: { task_id: 'task-1' },
            tool_response: { status: 'accepted', task_id: 'task-1' },
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'TaskStop',
            tool_input: { task_id: 'task-1' },
            tool_response: { task: { task_id: 'task-1', status: 'stopped' } },
        })).toEqual({ type: 'terminal', sessionId, taskId: 'task-1' });
    });

    it('maps exact SubagentStop to bounded terminal-before-confirmation evidence', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStop',
            session_id: sessionId,
            agent_id: ' agent-1 ',
        })).toEqual({
            type: 'terminal',
            sessionId,
            taskId: 'agent-1',
            rememberIfUnknown: true,
        });
    });

    it('terminalizes only the exact admitted sidechain on StopFailure', () => {
        const ledger = createClaudeProviderActivityLedger();
        for (const taskId of ['failed-agent', 'sibling-agent']) {
            const launch = readClaudeSessionHookProviderTaskActivity({
                hook_event_name: 'PostToolUse',
                session_id: sessionId,
                tool_name: 'Agent',
                tool_response: { status: 'async_launched', agentId: taskId },
            });
            if (!launch) throw new Error('expected exact async Agent launch');
            expect(ledger.apply(launch)).toBe(true);
        }

        const stopFailure = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'StopFailure',
            session_id: sessionId,
            agent_id: ' failed-agent ',
            error: 'authentication_failed',
        });
        expect(stopFailure).toEqual({
            type: 'terminal',
            terminalStatus: 'failed',
            sessionId,
            taskId: 'failed-agent',
            rememberIfUnknown: true,
        });
        if (!stopFailure) throw new Error('expected exact sidechain StopFailure');
        expect(ledger.apply(stopFailure)).toBe(true);
        expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
            sessionId,
            taskId: 'sibling-agent',
            sources: ['system-task-started'],
        }]);

        const siblingStopFailure = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'StopFailure',
            session_id: sessionId,
            agent_id: 'sibling-agent',
            error: 'authentication_failed',
        });
        if (!siblingStopFailure) throw new Error('expected exact sibling StopFailure');
        expect(ledger.apply(siblingStopFailure)).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.hasActiveProviderTasks()).toBe(false);

        for (const malformed of [
            { hook_event_name: 'StopFailure', session_id: sessionId, error: 'authentication_failed' },
            { hook_event_name: 'StopFailure', session_id: sessionId, agent_id: '   ' },
            { hook_event_name: 'StopFailure', session_id: sessionId, task_id: 'not-a-sidechain-identity' },
        ]) {
            expect(readClaudeSessionHookProviderTaskActivity(malformed)).toBeNull();
        }
    });
});

describe('createClaudeProviderActivityLedger', () => {
    it('keys membership by exact session/task tuple and removes only the exact sibling', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'same' });
        ledger.apply({ type: 'started', sessionId: 's2', taskId: 'same' });
        ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'same' });
        expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
            sessionId: 's2', taskId: 'same', sources: ['system-task-started'],
        }]);
    });

    it('deduplicates Workflow aliases and never expires silent affirmative truth', () => {
        vi.useFakeTimers();
        try {
            const ledger = createClaudeProviderActivityLedger();
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'workflow' });
            ledger.apply({ type: 'progress', sessionId: 's1', taskId: 'workflow' });
            vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
            expect(ledger.getActiveProviderTaskCount()).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not let progress admit an unknown task', () => {
        const ledger = createClaudeProviderActivityLedger();
        expect(ledger.apply({ type: 'progress', sessionId: 's1', taskId: 'unknown' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('consumes terminal-before-confirmation in the same map without publishing stale active', () => {
        const ledger = createClaudeProviderActivityLedger();
        expect(ledger.apply({
            type: 'terminal',
            sessionId: 's1',
            taskId: 'agent-1',
            rememberIfUnknown: true,
        })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'agent-1' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'agent-1' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-1' })).toBe(false);
    });

    it('lets only an exact successful SendMessage resume reactivate a terminal id', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({
            type: 'terminal',
            sessionId: 's1',
            taskId: 'agent-1',
            rememberIfUnknown: true,
        });

        expect(ledger.apply({
            type: 'started',
            sessionId: 's1',
            taskId: 'agent-1',
            source: 'hook-agent-resume',
        })).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
    });

    it('keeps typed terminal evidence authoritative over repeated late launch delivery', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' });
        ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'bash-1', terminalStatus: 'completed' });

        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('retains unknown typed terminal ordering over repeated late launch delivery', () => {
        const ledger = createClaudeProviderActivityLedger();
        const terminal = readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_notification',
            session_id: 's1',
            task_id: 'bash-1',
            status: 'completed',
        });
        if (!terminal) throw new Error('expected typed terminal activity');
        expect(ledger.apply(terminal)).toBe(false);

        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('makes update/notification terminal aliases idempotent in either order without clearing a sibling session', () => {
        const terminalRows = [
            {
                type: 'system',
                subtype: 'task_updated',
                session_id: 's1',
                task_id: 'same',
                patch: { status: 'killed' },
            },
            {
                type: 'system',
                subtype: 'task_notification',
                session_id: 's1',
                task_id: 'same',
                status: 'stopped',
            },
        ];
        for (const rows of [terminalRows, [...terminalRows].reverse()]) {
            const ledger = createClaudeProviderActivityLedger();
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'same' });
            ledger.apply({ type: 'started', sessionId: 's2', taskId: 'same' });
            const [first, second] = rows.map(readClaudeProviderTaskActivity);
            if (!first || !second) throw new Error('expected exact terminal activity');

            expect(ledger.apply(first)).toBe(true);
            expect(ledger.apply(second)).toBe(false);
            expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
                sessionId: 's2', taskId: 'same', sources: ['system-task-started'],
            }]);
        }
    });
});

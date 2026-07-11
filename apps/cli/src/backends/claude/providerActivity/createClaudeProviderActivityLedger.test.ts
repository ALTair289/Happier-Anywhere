import { describe, expect, it, vi } from 'vitest';

import {
    CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS,
    createClaudeProviderActivityLedger,
    readClaudeProviderTaskActivity,
} from './createClaudeProviderActivityLedger';

/** Manual clock + timer harness so TTL sweeps fire deterministically without real timers. */
function createTtlHarness() {
    let clockMs = 0;
    const pending: Array<{ fn: () => void; fireAt: number }> = [];
    const onActiveTasksExpired = vi.fn();
    const ledger = createClaudeProviderActivityLedger({
        now: () => clockMs,
        ttlMs: CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS,
        onActiveTasksExpired,
        setExpiryTimer: (fn, delayMs) => {
            const entry = { fn, fireAt: clockMs + delayMs };
            pending.push(entry);
            return () => {
                const index = pending.indexOf(entry);
                if (index >= 0) pending.splice(index, 1);
            };
        },
    });
    const advance = (deltaMs: number) => {
        clockMs += deltaMs;
        // Fire any due timers (the ledger arms at most one at a time and re-arms on fire).
        for (let guard = 0; guard < 100; guard += 1) {
            const due = pending.find((entry) => entry.fireAt <= clockMs);
            if (!due) break;
            pending.splice(pending.indexOf(due), 1);
            due.fn();
        }
    };
    return { ledger, advance, onActiveTasksExpired };
}

describe('readClaudeProviderTaskActivity', () => {
    it('classifies async tool results as background task activity', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'user',
            tool_use_result: {
                assistant_auto_backgrounded: true,
                background_task_id: ' task-1 ',
            },
        })).toEqual({ type: 'background', taskId: 'task-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'user',
            toolUseResult: {
                status: 'async_launched',
                agentId: 'agent-1',
            },
        })).toEqual({ type: 'background', taskId: 'agent-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'user',
            toolUseResult: {
                backgroundTaskId: ' bash-task-1 ',
            },
        })).toEqual({ type: 'background', taskId: 'bash-task-1' });
    });

    it('classifies system task lifecycle events with normalized task ids', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_started',
            task_id: ' task-1 ',
        })).toEqual({ type: 'started', taskId: 'task-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_progress',
            agent_id: 'agent-1',
        })).toEqual({ type: 'progress', taskId: 'agent-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_updated',
            taskId: 'task-2',
        })).toEqual({ type: 'progress', taskId: 'task-2' });
    });

    it('classifies task notifications by SDK terminal status vocabulary', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-1',
            status: 'succeeded',
        })).toEqual({ type: 'terminal', taskId: 'task-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-2',
            patch: { status: 'Errored' },
        })).toEqual({ type: 'terminal', taskId: 'task-2' });

        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-3',
            status: 'running',
        })).toEqual({ type: 'progress', taskId: 'task-3' });

        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_updated',
            task_id: 'task-4',
            patch: { status: 'completed' },
        })).toEqual({ type: 'terminal', taskId: 'task-4' });
    });

    it('ignores events without provider task activity', () => {
        expect(readClaudeProviderTaskActivity({ type: 'assistant' })).toBeNull();
        expect(readClaudeProviderTaskActivity({ type: 'system', subtype: 'task_started' })).toBeNull();
        expect(readClaudeProviderTaskActivity({ type: 'system', subtype: 'init', task_id: 'task-1' })).toBeNull();
        expect(readClaudeProviderTaskActivity({
            type: 'user',
            tool_use_result: { status: 'completed', task_id: 'task-1' },
        })).toBeNull();
    });
});

describe('createClaudeProviderActivityLedger', () => {
    it('records assistant-auto-backgrounded tool results with the canonical background source', () => {
        const ledger = createClaudeProviderActivityLedger();

        ledger.noteBackgroundProviderTask(' task-1 ');

        expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
            taskId: 'task-1',
            sources: ['assistant-auto-backgrounded-tool-result'],
        }]);
    });

    it('stops blocking hasActiveProviderTasks once a task has no events past the TTL (W-3)', () => {
        const { ledger, advance } = createTtlHarness();
        ledger.noteProviderTaskStarted('task-1');
        expect(ledger.hasActiveProviderTasks()).toBe(true);

        advance(CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS - 1);
        expect(ledger.hasActiveProviderTasks()).toBe(true);

        advance(2);
        expect(ledger.hasActiveProviderTasks()).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('keeps a task alive when progress renews it inside the TTL window', () => {
        const { ledger, advance } = createTtlHarness();
        ledger.noteProviderTaskStarted('task-1');
        advance(CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS - 10);
        ledger.noteProviderTaskProgress('task-1');
        // Past the ORIGINAL deadline but within a fresh TTL from the progress event.
        advance(20);
        expect(ledger.hasActiveProviderTasks()).toBe(true);
    });

    it('re-checks idle emission when a TTL fires with no further events', () => {
        const { ledger, advance, onActiveTasksExpired } = createTtlHarness();
        ledger.noteProviderTaskStarted('task-1');
        expect(onActiveTasksExpired).not.toHaveBeenCalled();

        advance(CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS + 1);
        expect(onActiveTasksExpired).toHaveBeenCalledTimes(1);
        expect(ledger.hasActiveProviderTasks()).toBe(false);
    });

    it('does not fire the expiry callback when a task terminates normally', () => {
        const { ledger, advance, onActiveTasksExpired } = createTtlHarness();
        ledger.noteProviderTaskStarted('task-1');
        ledger.noteProviderTaskFinished('task-1');
        advance(CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS + 1);
        expect(onActiveTasksExpired).not.toHaveBeenCalled();
        expect(ledger.hasActiveProviderTasks()).toBe(false);
    });
});

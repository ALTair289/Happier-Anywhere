import { describe, expect, it } from 'vitest';

import {
    createClaudeProviderActivityLedger,
    readClaudeProviderTaskActivity,
} from './createClaudeProviderActivityLedger';

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
});

import {
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeAgentSdkProviderTaskId,
    normalizeClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkProviderTaskStatus,
} from '@happier-dev/protocol';
import type { SessionRuntimeActivityPublisher } from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';

export const CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID = 'claude';
export const CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS = 'provider_detached_task';

export type ClaudeProviderRuntimeActivityPublisher = Pick<
    SessionRuntimeActivityPublisher,
    'setSourceActive' | 'observeSource' | 'clearSource' | 'clearProviderSources'
>;

export type ClaudeProviderTaskActivity =
    | Readonly<{ type: 'background'; taskId: string }>
    | Readonly<{ type: 'started'; taskId: string }>
    | Readonly<{ type: 'progress'; taskId: string }>
    | Readonly<{ type: 'terminal'; taskId: string }>;

export type ClaudeProviderActivitySource =
    | 'assistant-auto-backgrounded-tool-result'
    | 'system-task-progress'
    | 'system-task-started'
    | 'transcript-async-agent-launch';

export {
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeAgentSdkProviderTaskId,
    normalizeClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkProviderTaskStatus,
} from '@happier-dev/protocol';

export type ClaudeProviderTaskBlocker = {
    taskId: string;
    sources: ClaudeProviderActivitySource[];
};

type ProviderTaskEntry = {
    taskId: string;
    sources: Set<ClaudeProviderActivitySource>;
};

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readProviderTaskId(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) return null;
    return normalizeClaudeAgentSdkProviderTaskId(
        record.task_id
        ?? record.taskId
        ?? record.agent_id
        ?? record.agentId,
    );
}

export function buildClaudeProviderTaskRuntimeActivitySourceId(taskId: unknown): string | null {
    const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
    return normalizedTaskId ? `claude:provider-task:${normalizedTaskId}` : null;
}

export function readClaudeBackgroundProviderTaskId(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) return null;
    const taskResultRecord = readRecord(record.tool_use_result ?? record.toolUseResult);
    if (!taskResultRecord) return null;
    const explicitBackgroundTaskId = normalizeClaudeAgentSdkProviderTaskId(
        taskResultRecord.backgroundTaskId
        ?? taskResultRecord.background_task_id,
    );
    if (explicitBackgroundTaskId) return explicitBackgroundTaskId;

    const status = normalizeClaudeAgentSdkProviderTaskStatus(taskResultRecord.status);
    const launchedAsync = taskResultRecord.assistantAutoBackgrounded === true
        || taskResultRecord.assistant_auto_backgrounded === true
        || taskResultRecord.isAsync === true
        || status === 'async_launched';
    if (!launchedAsync) return null;

    return normalizeClaudeAgentSdkProviderTaskId(
        taskResultRecord.taskId
        ?? taskResultRecord.task_id
        ?? taskResultRecord.agentId
        ?? taskResultRecord.agent_id,
    );
}

export function readClaudeProviderTaskActivity(value: unknown): ClaudeProviderTaskActivity | null {
    const backgroundTaskId = readClaudeBackgroundProviderTaskId(value);
    if (backgroundTaskId) {
        return { type: 'background', taskId: backgroundTaskId };
    }

    const record = readRecord(value);
    if (!record || record.type !== 'system') return null;
    const taskId = readProviderTaskId(record);
    if (!taskId) return null;

    const status = readClaudeAgentSdkProviderTaskStatus(record);
    const isTerminalStatus = isTerminalClaudeAgentSdkProviderTaskStatus(status);

    switch (record.subtype) {
        case 'task_started':
            return isTerminalStatus
                ? { type: 'terminal', taskId }
                : { type: 'started', taskId };
        case 'task_progress':
        case 'task_updated':
            return isTerminalStatus
                ? { type: 'terminal', taskId }
                : { type: 'progress', taskId };
        case 'task_notification':
            return isTerminalStatus
                ? { type: 'terminal', taskId }
                : { type: 'progress', taskId };
        default:
            return null;
    }
}

export function createClaudeProviderActivityLedger() {
    const activeProviderTasks = new Map<string, ProviderTaskEntry>();

    const noteProviderTask = (
        taskId: unknown,
        source: ClaudeProviderActivitySource,
    ): string | null => {
        const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
        if (!normalizedTaskId) return null;

        const existing = activeProviderTasks.get(normalizedTaskId);
        if (existing) {
            existing.sources.add(source);
            return normalizedTaskId;
        }

        activeProviderTasks.set(normalizedTaskId, {
            taskId: normalizedTaskId,
            sources: new Set([source]),
        });
        return normalizedTaskId;
    };

    return {
        getActiveProviderTaskBlockers: (): ClaudeProviderTaskBlocker[] => Array.from(activeProviderTasks.values())
            .map((entry) => ({
                taskId: entry.taskId,
                sources: Array.from(entry.sources),
            })),
        getActiveProviderTaskCount: (): number => activeProviderTasks.size,
        hasActiveProviderTasks: (): boolean => activeProviderTasks.size > 0,
        noteBackgroundProviderTask: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'assistant-auto-backgrounded-tool-result',
        ),
        noteTranscriptAsyncAgentTask: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'transcript-async-agent-launch',
        ),
        noteProviderTaskFinished: (taskId: unknown): string | null => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            if (!normalizedTaskId) return null;
            activeProviderTasks.delete(normalizedTaskId);
            return normalizedTaskId;
        },
        noteProviderTaskProgress: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'system-task-progress',
        ),
        noteProviderTaskStarted: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'system-task-started',
        ),
        clearProviderTasks: (): void => {
            activeProviderTasks.clear();
        },
    };
}

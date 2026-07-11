import {
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeAgentSdkProviderTaskId,
    normalizeClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkProviderTaskStatus,
} from '@happier-dev/protocol';
import type { SessionRuntimeActivityPublisher } from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';
import { logger } from '@/ui/logger';

export const CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID = 'claude';
export const CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS = 'provider_detached_task';

/**
 * Backstop TTL (W-3) for a provider task in the "is the session still working?" ledger. A dropped
 * terminal `task_updated` (connection gap / mode switch) would otherwise keep the session pinned
 * "working" until the process restarts. A task with no progress/terminal event within this window
 * stops blocking `hasActiveProviderTasks()`. Hook reconciliation stays the canonical clearer; this
 * is only the safety net for the case where no event ever arrives.
 */
export const CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS = 10 * 60_000;

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
    /** Wall-clock ms of the most recent event for this task; drives the TTL backstop (W-3). */
    lastEventAt: number;
};

/** Cancel handle for a scheduled expiry re-check. */
type CancelTimer = () => void;

export type ClaudeProviderActivityLedgerOptions = Readonly<{
    /** Injectable clock (default `Date.now`); tests advance it deterministically. */
    now?: () => number;
    /** Per-task inactivity TTL in ms (default {@link CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS}). */
    ttlMs?: number;
    /**
     * Invoked after a TTL sweep drops one or more tasks, so the owner can re-check idle emission
     * (the session may have gone completely silent with no further events to trigger the check).
     */
    onActiveTasksExpired?: () => void;
    /**
     * Injectable proactive-expiry scheduler (default `setTimeout` with `unref`). Tests pass a
     * manual scheduler so the sweep fires deterministically without real timers.
     */
    setExpiryTimer?: (fn: () => void, delayMs: number) => CancelTimer;
}>;

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

const defaultExpiryTimer = (fn: () => void, delayMs: number): CancelTimer => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
};

export function createClaudeProviderActivityLedger(options?: ClaudeProviderActivityLedgerOptions) {
    const activeProviderTasks = new Map<string, ProviderTaskEntry>();
    const now = options?.now ?? Date.now;
    const ttlMs = options?.ttlMs ?? CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS;
    const onActiveTasksExpired = options?.onActiveTasksExpired;
    const setExpiryTimer = options?.setExpiryTimer ?? defaultExpiryTimer;
    let cancelExpiryTimer: CancelTimer | null = null;

    /** Drop tasks whose last event is older than the TTL. Returns the dropped task ids. */
    const pruneExpiredProviderTasks = (): string[] => {
        const nowMs = now();
        const expired: string[] = [];
        for (const [taskId, entry] of activeProviderTasks) {
            if (entry.lastEventAt + ttlMs <= nowMs) {
                activeProviderTasks.delete(taskId);
                expired.push(taskId);
            }
        }
        if (expired.length > 0) {
            logger.debug(
                `[claude-provider-activity] dropped ${expired.length} stale provider task(s) after ${ttlMs}ms TTL: ${expired.join(', ')}`,
            );
        }
        return expired;
    };

    const clearExpiryTimer = (): void => {
        if (cancelExpiryTimer) {
            cancelExpiryTimer();
            cancelExpiryTimer = null;
        }
    };

    /** (Re)arm a single proactive sweep at the earliest task deadline so a silent session still idles. */
    const rescheduleExpiryTimer = (): void => {
        clearExpiryTimer();
        if (activeProviderTasks.size === 0) return;
        const nowMs = now();
        let earliestDeadline = Infinity;
        for (const entry of activeProviderTasks.values()) {
            earliestDeadline = Math.min(earliestDeadline, entry.lastEventAt + ttlMs);
        }
        const delayMs = Math.max(0, earliestDeadline - nowMs);
        cancelExpiryTimer = setExpiryTimer(() => {
            cancelExpiryTimer = null;
            const expired = pruneExpiredProviderTasks();
            rescheduleExpiryTimer();
            if (expired.length > 0) onActiveTasksExpired?.();
        }, delayMs);
    };

    const noteProviderTask = (
        taskId: unknown,
        source: ClaudeProviderActivitySource,
    ): string | null => {
        const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
        if (!normalizedTaskId) return null;

        const nowMs = now();
        const existing = activeProviderTasks.get(normalizedTaskId);
        if (existing) {
            existing.sources.add(source);
            existing.lastEventAt = nowMs;
        } else {
            activeProviderTasks.set(normalizedTaskId, {
                taskId: normalizedTaskId,
                sources: new Set([source]),
                lastEventAt: nowMs,
            });
        }
        rescheduleExpiryTimer();
        return normalizedTaskId;
    };

    return {
        getActiveProviderTaskBlockers: (): ClaudeProviderTaskBlocker[] => {
            pruneExpiredProviderTasks();
            return Array.from(activeProviderTasks.values())
                .map((entry) => ({
                    taskId: entry.taskId,
                    sources: Array.from(entry.sources),
                }));
        },
        getActiveProviderTaskCount: (): number => {
            pruneExpiredProviderTasks();
            return activeProviderTasks.size;
        },
        hasActiveProviderTasks: (): boolean => {
            pruneExpiredProviderTasks();
            return activeProviderTasks.size > 0;
        },
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
            rescheduleExpiryTimer();
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
            clearExpiryTimer();
        },
    };
}

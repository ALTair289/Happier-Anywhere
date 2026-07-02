import {
  isTerminalClaudeAgentSdkProviderTaskStatus,
  normalizeClaudeAgentSdkProviderTaskId,
  normalizeClaudeAgentSdkProviderTaskStatus,
} from '../providerActivity/createClaudeProviderActivityLedger';
import type { SessionHookData } from './startHookServer';

export type ClaudeSessionHookBackgroundTasks = Readonly<{
  activeTaskIds: ReadonlySet<string>;
  terminalTaskIds: ReadonlySet<string>;
  reportsEmpty: boolean;
}>;

function readBackgroundTaskArray(data: SessionHookData): readonly unknown[] | null {
  const raw = data.background_tasks ?? data.backgroundTasks;
  return Array.isArray(raw) ? raw : null;
}

function readHookBackgroundTaskId(value: unknown): string | null {
  if (typeof value === 'string') return normalizeClaudeAgentSdkProviderTaskId(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return normalizeClaudeAgentSdkProviderTaskId(
    record.task_id
    ?? record.taskId
    ?? record.agent_id
    ?? record.agentId
    ?? record.id,
  );
}

function hookBackgroundTaskIsTerminal(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isTerminalClaudeAgentSdkProviderTaskStatus(
    normalizeClaudeAgentSdkProviderTaskStatus(record.status),
  );
}

export function readClaudeSessionHookBackgroundTasks(
  data: SessionHookData,
): ClaudeSessionHookBackgroundTasks | null {
  const raw = readBackgroundTaskArray(data);
  if (!raw) return null;
  const activeTaskIds = new Set<string>();
  const terminalTaskIds = new Set<string>();
  for (const item of raw) {
    const taskId = readHookBackgroundTaskId(item);
    if (!taskId) continue;
    if (hookBackgroundTaskIsTerminal(item)) {
      terminalTaskIds.add(taskId);
    } else {
      activeTaskIds.add(taskId);
    }
  }
  return {
    activeTaskIds,
    terminalTaskIds,
    reportsEmpty: raw.length === 0,
  };
}

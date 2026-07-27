import {
  isTerminalClaudeAgentSdkProviderTaskStatus,
  normalizeClaudeAgentSdkProviderTaskId,
  normalizeClaudeAgentSdkProviderTaskStatus,
} from '@/backends/claude/providerActivity/createClaudeProviderActivityLedger';
import { parseClaudeTaskNotificationXml } from '@/backends/claude/taskNotifications/claudeTaskNotificationXml';
import type { RawJSONLines } from '@/backends/claude/types';

export type ClaudeTranscriptProviderActivity =
  | Readonly<{ type: 'task_notification'; taskId: string | null; toolUseId: string | null; terminal: boolean }>
  | Readonly<{ type: 'task_notification_unknown'; taskId: string | null; toolUseId: string | null }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOriginKind(message: RawJSONLines): string {
  return normalizeString(asRecord(asRecord(message)?.origin)?.kind);
}

function readTaskNotificationOrigin(message: RawJSONLines): Readonly<{
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
}> | null {
  const origin = asRecord(asRecord(message)?.origin);
  if (normalizeString(origin?.kind) !== 'task-notification') return null;
  const taskId = normalizeClaudeAgentSdkProviderTaskId(origin?.taskId ?? origin?.task_id);
  const toolUseId = normalizeClaudeAgentSdkProviderTaskId(origin?.toolUseId ?? origin?.tool_use_id);
  const status = normalizeClaudeAgentSdkProviderTaskStatus(origin?.status);
  return { taskId, toolUseId, status };
}

export function isClaudeTranscriptTaskNotification(message: RawJSONLines): boolean {
  return readOriginKind(message) === 'task-notification' || parseClaudeTaskNotificationXml(message) !== null;
}

function readTaskNotificationActivity(message: RawJSONLines): ClaudeTranscriptProviderActivity | null {
  if (!isClaudeTranscriptTaskNotification(message)) return null;
  const origin = readTaskNotificationOrigin(message);
  const parsed = parseClaudeTaskNotificationXml(message);
  const taskId = origin?.taskId ?? parsed?.taskId ?? null;
  const toolUseId = origin?.toolUseId ?? parsed?.toolUseId ?? null;
  const status = origin?.status ?? parsed?.status ?? null;
  if (status === null) {
    return { type: 'task_notification_unknown', taskId, toolUseId };
  }
  return {
    type: 'task_notification',
    taskId,
    toolUseId,
    terminal: isTerminalClaudeAgentSdkProviderTaskStatus(status),
  };
}

export function readClaudeTranscriptProviderActivity(message: RawJSONLines): ClaudeTranscriptProviderActivity | null {
  return readTaskNotificationActivity(message);
}

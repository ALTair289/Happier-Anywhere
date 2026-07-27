import {
  isTerminalClaudeAgentSdkProviderTaskStatus,
  normalizeClaudeAgentSdkProviderTaskId,
  normalizeClaudeAgentSdkProviderTaskStatus,
} from '../providerActivity/createClaudeProviderActivityLedger';
import { parseClaudeTaskNotificationXml } from '../taskNotifications/claudeTaskNotificationXml';
import { readSessionHookEventName } from './sessionHookAttribution';
import type { SessionHookData } from './startHookServer';

export type ClaudeSessionHookTaskNotification = Readonly<{
  taskId: string;
  toolUseId: string | null;
  status: string | null;
  terminal: boolean;
}>;

function readHookPromptText(data: SessionHookData): string | null {
  const raw = data.prompt;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

export function readClaudeSessionHookTaskNotification(
  data: SessionHookData,
): ClaudeSessionHookTaskNotification | null {
  if (readSessionHookEventName(data) !== 'UserPromptSubmit') return null;
  const notification = parseClaudeTaskNotificationXml(readHookPromptText(data));
  const taskId = normalizeClaudeAgentSdkProviderTaskId(notification?.taskId);
  if (!taskId) return null;
  const status = normalizeClaudeAgentSdkProviderTaskStatus(notification?.status);
  return {
    taskId,
    toolUseId: normalizeClaudeAgentSdkProviderTaskId(notification?.toolUseId),
    status,
    terminal: isTerminalClaudeAgentSdkProviderTaskStatus(status),
  };
}

export function isClaudeTaskNotificationUserPromptHook(data: SessionHookData): boolean {
  return readClaudeSessionHookTaskNotification(data) !== null;
}

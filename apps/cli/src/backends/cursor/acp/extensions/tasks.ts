import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  type AcpExtensionHandlerContext,
  type AcpExtensionRegistration,
} from '@/agent/acp/connection/types';

import {
  cursorTaskNotificationSchema,
  type CursorTaskNotification,
} from './schemas';

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function presentText(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

function normalizeSubagentType(value: CursorTaskNotification['subagentType']): Readonly<{
  type?: string;
  customType?: string;
}> {
  if (typeof value === 'string') {
    const type = nonEmpty(value);
    return type ? { type } : {};
  }
  const customType = nonEmpty(value?.custom);
  return customType ? { type: 'custom', customType } : {};
}

function observeCursorTask(
  payload: CursorTaskNotification,
  context: AcpExtensionHandlerContext,
): void {
  if (payload.toolCallId === undefined || !context.toolCalls) return;

  const description = nonEmpty(payload.description);
  const prompt = presentText(payload.prompt);
  const model = nonEmpty(payload.model);
  const agentId = nonEmpty(payload.agentId);
  const subagent = normalizeSubagentType(payload.subagentType);
  const canonicalType = subagent.customType ?? subagent.type;

  context.toolCalls.enrich(payload.toolCallId, {
    toolName: 'Task',
    ...(description ? { title: description } : {}),
    rawInput: {
      operation: 'run',
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      ...(canonicalType ? { subagent_type: canonicalType } : {}),
      ...(model ? { model } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(payload.durationMs !== undefined ? { duration_ms: payload.durationMs } : {}),
      _happier: {
        nativeSubagent: {
          v: 1,
          lifecycle: 'completion_only',
          ...(subagent.type ? { type: subagent.type } : {}),
          ...(subagent.customType ? { customType: subagent.customType } : {}),
          ...(model ? { model } : {}),
          ...(agentId ? { agentId } : {}),
          ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        },
      },
    },
    metadata: {
      providerNativeTask: {
        v: 1,
        completionOnly: true,
      },
    },
  });
}

export function createCursorTaskDescriptors(): ReadonlyArray<AcpExtensionRegistration> {
  return [
    defineAcpExtensionRequest({
      method: 'cursor/task',
      params: cursorTaskNotificationSchema,
      handler: async (payload, context) => {
        observeCursorTask(payload, context);
        return {};
      },
    }),
    defineAcpExtensionNotification({
      method: 'cursor/task',
      params: cursorTaskNotificationSchema,
      handler: async (payload, context) => {
        observeCursorTask(payload, context);
      },
    }),
  ];
}

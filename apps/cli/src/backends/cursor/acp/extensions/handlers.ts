import type { AcpExtensionHandlers, AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentMessage } from '@/agent/core';
import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
} from '@/agent/acp/connection/types';

import { createCursorGeneratedMediaDescriptors } from './generatedMedia';
import { handleCursorCreatePlan } from './plans';
import { handleCursorAskQuestion } from './questions';
import {
  cursorAskQuestionRequestSchema,
  cursorCreatePlanRequestSchema,
  cursorUpdateTodosRequestSchema,
} from './schemas';
import { createCursorTaskDescriptors } from './tasks';
import { CursorTodosAdapter } from './todos';

export function buildCursorExtensionHandlers(params: Readonly<{
  permissionHandler: AcpPermissionHandler;
  emitAgentMessage?: (message: AgentMessage) => void;
}>): AcpExtensionHandlers {
  const todos = new CursorTodosAdapter();
  const updateTodos = async (
    request: Parameters<CursorTodosAdapter['handleUpdate']>[0],
    context: Parameters<CursorTodosAdapter['handleUpdate']>[1],
  ) => await todos.handleUpdate(request, context);

  return [
    defineAcpExtensionRequest({
      method: 'cursor/ask_question',
      params: cursorAskQuestionRequestSchema,
      handler: async (request, context) => await handleCursorAskQuestion({
        request,
        context,
        permissionHandler: params.permissionHandler,
      }),
    }),
    defineAcpExtensionRequest({
      method: 'cursor/create_plan',
      params: cursorCreatePlanRequestSchema,
      handler: async (request, context) => {
        const toolCallId = request.toolCallId ?? `cursor-plan-${crypto.randomUUID()}`;
        await todos.surfacePlanTodos({ request, toolCallId, context });
        return await handleCursorCreatePlan({
          request: { ...request, toolCallId },
          context,
          permissionHandler: params.permissionHandler,
        });
      },
    }),
    defineAcpExtensionRequest({
      method: 'cursor/update_todos',
      params: cursorUpdateTodosRequestSchema,
      handler: updateTodos,
    }),
    defineAcpExtensionNotification({
      method: 'cursor/update_todos',
      params: cursorUpdateTodosRequestSchema,
      handler: async (request, context) => {
        await updateTodos(request, context);
      },
    }),
    ...createCursorTaskDescriptors(),
    ...createCursorGeneratedMediaDescriptors({
      emit: params.emitAgentMessage ?? (() => undefined),
    }),
  ];
}

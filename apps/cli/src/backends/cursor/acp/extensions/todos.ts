import type { AcpExtensionHandlerContext } from '@/agent/acp/AcpBackend';
import { normalizeAcpPlan } from '@/agent/acp/plans';

import type {
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
} from './schemas';

export type CursorTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type CursorTodo = Readonly<{
  id?: string;
  content: string;
  status: CursorTodoStatus;
  phaseName?: string;
}>;

function normalizeStatus(status: string | undefined): CursorTodoStatus {
  switch (status?.trim().toLowerCase()) {
    case 'inprogress':
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}
function normalizeTodo(raw: Readonly<{
  id?: string;
  content?: string;
  title?: string;
  status?: string;
}>): CursorTodo | null {
  const content = raw.content?.trim() || raw.title?.trim() || '';
  if (!content) return null;
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : undefined;
  return {
    ...(id ? { id } : {}),
    content,
    status: normalizeStatus(raw.status),
  };
}

export function normalizeCursorTodos(
  request: Pick<CursorUpdateTodosRequest, 'todos'>,
): CursorTodo[] {
  return request.todos.map(normalizeTodo).filter((todo): todo is CursorTodo => todo !== null);
}

export function buildCursorPlanTodos(request: CursorCreatePlanRequest): CursorTodo[] {
  const todos = (request.todos ?? [])
    .map(normalizeTodo)
    .filter((todo): todo is CursorTodo => todo !== null);
  const indexById = new Map<string, number>();
  todos.forEach((todo, index) => {
    if (todo.id) indexById.set(todo.id, index);
  });

  for (const phase of request.phases ?? []) {
    const phaseName = phase.name?.trim();
    for (const rawTodo of phase.todos ?? []) {
      const todo = normalizeTodo(rawTodo);
      if (!todo) continue;
      const existingIndex = todo.id ? indexById.get(todo.id) : undefined;
      if (existingIndex !== undefined) {
        const existing = todos[existingIndex]!;
        if (phaseName && !existing.phaseName) {
          todos[existingIndex] = { ...existing, phaseName };
        }
        continue;
      }
      if (todo.id) indexById.set(todo.id, todos.length);
      todos.push({ ...todo, ...(phaseName ? { phaseName } : {}) });
    }
  }
  return todos;
}

export class CursorTodosAdapter {
  async surfacePlanTodos(params: Readonly<{
    request: CursorCreatePlanRequest;
    toolCallId: string;
    context: AcpExtensionHandlerContext;
  }>): Promise<void> {
    const todos = buildCursorPlanTodos(params.request);
    await this.surface(params.toolCallId, todos, false, params.request.plan, params.context);
  }

  async handleUpdate(
    request: CursorUpdateTodosRequest,
    context: AcpExtensionHandlerContext,
  ): Promise<Record<string, never>> {
    const toolCallId = request.toolCallId ?? `cursor-todos-${crypto.randomUUID()}`;
    const incoming = normalizeCursorTodos(request);
    await this.surface(toolCallId, incoming, request.merge === true, undefined, context);
    return {};
  }

  private async surface(
    toolCallId: string,
    todos: ReadonlyArray<CursorTodo>,
    merge: boolean,
    markdown: string | undefined,
    context: AcpExtensionHandlerContext,
  ): Promise<void> {
    if (!context.turnId || !context.plans) {
      throw new Error('ACP plan projection is unavailable for Cursor todo delivery');
    }
    const normalized = normalizeAcpPlan({
      providerId: context.agentName,
      turnId: context.turnId,
      correlationId: toolCallId,
      source: 'proprietary',
      merge,
      ...(markdown ? { markdown } : {}),
      items: todos,
    });
    if (normalized) await context.plans.project(normalized);
  }
}

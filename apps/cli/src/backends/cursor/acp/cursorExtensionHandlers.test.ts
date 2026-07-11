import { describe, expect, it } from 'vitest';

import type { ClientApp } from '@agentclientprotocol/sdk';
import type {
  AcpExtensionHandlerContext,
  AcpExtensionHandlers,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';
import {
  buildCursorAskQuestionInput,
  buildCursorExtensionHandlers,
  buildCursorTodoWriteInput,
  extractCursorPlanMarkdown,
} from './cursorExtensionHandlers';

type CapturedCall = Readonly<{
  id: string;
  toolName: string;
  input: unknown;
}>;

type ExtensionCallback = (context: Readonly<{
  params: Record<string, unknown>;
  signal: AbortSignal;
}>) => unknown | Promise<unknown>;

async function invokeCursorExtension(params: Readonly<{
  handlers: AcpExtensionHandlers;
  kind: 'request' | 'notification';
  method: string;
  payload: Record<string, unknown>;
  context: AcpExtensionHandlerContext;
}>): Promise<unknown> {
  const registration = params.handlers.find((candidate) => (
    candidate.kind === params.kind && candidate.method === params.method
  ));
  if (!registration) {
    throw new Error(`Missing ${params.kind} handler for ${params.method}`);
  }

  const captured: { callback: ExtensionCallback | null } = { callback: null };
  const app = {
    onRequest: (_method: string, _parser: unknown, handler: unknown) => {
      captured.callback = handler as ExtensionCallback;
      return app;
    },
    onNotification: (_method: string, _parser: unknown, handler: unknown) => {
      captured.callback = handler as ExtensionCallback;
      return app;
    },
  };
  // The SDK client is an external transport boundary. This fixture captures only the registered callback.
  registration.register(app as unknown as ClientApp, () => params.context);
  if (!captured.callback) {
    throw new Error(`Handler registration did not register ${params.method}`);
  }
  return await captured.callback({ params: params.payload, signal: params.context.signal });
}

class CapturingPermissionHandler implements AcpPermissionHandler {
  readonly calls: CapturedCall[] = [];

  constructor(
    private readonly decision: Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> & {
      answers?: Record<string, string>;
    } = { decision: 'approved' },
  ) {}

  async handleToolCall(id: string, toolName: string, input: unknown) {
    this.calls.push({ id, toolName, input });
    return this.decision;
  }
}

describe('Cursor ACP extension handlers', () => {
  it('normalizes ask_question payloads to the canonical AskUserQuestion input shape', () => {
    expect(buildCursorAskQuestionInput({
      toolCallId: 'ask-1',
      title: 'Need input',
      questions: [
        {
          id: 'language',
          prompt: 'Which language should I use?',
          options: [
            { id: 'ts', label: 'TypeScript' },
            { id: 'rs', label: 'Rust' },
          ],
        },
      ],
    })).toEqual({
      questions: [
        {
          id: 'language',
          header: 'Need input',
          question: 'Which language should I use?',
          multiSelect: false,
          options: [
            { label: 'TypeScript', description: 'TypeScript' },
            { label: 'Rust', description: 'Rust' },
          ],
        },
      ],
    });
  });

  it('returns ask_question answers keyed by Cursor question id', async () => {
    const permissionHandler = new CapturingPermissionHandler({
      decision: 'approved',
      answers: {
        language: 'TypeScript',
      },
    });

    const result = await invokeCursorExtension({
      handlers: buildCursorExtensionHandlers({ permissionHandler }),
      kind: 'request',
      method: 'cursor/ask_question',
      payload: {
        toolCallId: 'ask-1',
        questions: [
          {
            id: 'language',
            prompt: 'Which language should I use?',
            options: [{ id: 'ts', label: 'TypeScript' }],
          },
        ],
      },
      context: { method: 'cursor/ask_question', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' },
    });

    expect(permissionHandler.calls).toEqual([
      {
        id: 'ask-1',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              id: 'language',
              header: 'Question',
              question: 'Which language should I use?',
              multiSelect: false,
              options: [{ label: 'TypeScript', description: 'TypeScript' }],
            },
          ],
        },
      },
    ]);
    expect(result).toEqual({ answers: { language: 'TypeScript' } });
  });

  it('normalizes create_plan payloads to ExitPlanMode and returns Cursor accepted state', async () => {
    const permissionHandler = new CapturingPermissionHandler({ decision: 'approved' });

    const result = await invokeCursorExtension({
      handlers: buildCursorExtensionHandlers({ permissionHandler }),
      kind: 'request',
      method: 'cursor/create_plan',
      payload: {
        toolCallId: 'plan-1',
        name: 'Refactor parser',
        plan: '# Plan\n\n1. Add schemas',
        todos: [],
      },
      context: { method: 'cursor/create_plan', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' },
    });

    expect(permissionHandler.calls).toEqual([
      {
        id: 'plan-1',
        toolName: 'ExitPlanMode',
        input: {
          plan: '# Plan\n\n1. Add schemas',
          name: 'Refactor parser',
          overview: '',
          isProject: false,
        },
      },
    ]);
    expect(result).toEqual({ accepted: true });
  });

  it('reports create_plan rejection to Cursor without throwing', async () => {
    const permissionHandler = new CapturingPermissionHandler({ decision: 'denied' });

    const result = await invokeCursorExtension({
      handlers: buildCursorExtensionHandlers({ permissionHandler }),
      kind: 'request',
      method: 'cursor/create_plan',
      payload: {
        toolCallId: 'plan-1',
        plan: '# Plan',
        todos: [],
      },
      context: { method: 'cursor/create_plan', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' },
    });

    expect(result).toEqual({ accepted: false });
  });

  it('normalizes update_todos payloads to TodoWrite for requests and notifications', async () => {
    const permissionHandler = new CapturingPermissionHandler();
    const handlers = buildCursorExtensionHandlers({ permissionHandler });
    const payload = {
      toolCallId: 'todos-1',
      merge: true,
      todos: [
        { id: '1', content: 'Inspect state', status: 'completed' },
        { id: '2', title: 'Apply fix', status: 'inProgress' },
        { id: '3', content: 'Unknown status', status: 'weird' },
        { id: '4', content: '   ' },
      ],
    };

    const context = { method: 'cursor/update_todos', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' } as const;
    await invokeCursorExtension({ handlers, kind: 'notification', method: 'cursor/update_todos', payload, context });
    const result = await invokeCursorExtension({ handlers, kind: 'request', method: 'cursor/update_todos', payload, context });

    expect(buildCursorTodoWriteInput(payload)).toEqual({
      todos: [
        { id: '1', content: 'Inspect state', status: 'completed' },
        { id: '2', content: 'Apply fix', status: 'in_progress' },
        { id: '3', content: 'Unknown status', status: 'pending' },
      ],
    });
    expect(permissionHandler.calls.map((call) => call.toolName)).toEqual(['TodoWrite', 'TodoWrite']);
    expect(result).toEqual({});
  });

  it('falls back when Cursor omits plan text', () => {
    expect(extractCursorPlanMarkdown({})).toBe('# Plan\n\n(Cursor did not supply plan text.)');
  });

  it('surfaces create_plan todos through TodoWrite in addition to ExitPlanMode prose', async () => {
    const permissionHandler = new CapturingPermissionHandler({ decision: 'approved' });

    const result = await invokeCursorExtension({
      handlers: buildCursorExtensionHandlers({ permissionHandler }),
      kind: 'request',
      method: 'cursor/create_plan',
      payload: {
        toolCallId: 'plan-1',
        name: 'python-hello-plan',
        plan: '# Python Hello-World Plan',
        todos: [
          { id: 'write-script', content: 'Add the script', status: 'pending' },
          { id: 'run-script', content: 'Run it', status: 'pending' },
        ],
      },
      context: { method: 'cursor/create_plan', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' },
    });

    // TodoWrite (structured checklist) is surfaced first, then the blocking ExitPlanMode prose card.
    expect(permissionHandler.calls).toEqual([
      {
        id: 'plan-1-todos',
        toolName: 'TodoWrite',
        input: {
          todos: [
            { id: 'write-script', content: 'Add the script', status: 'pending' },
            { id: 'run-script', content: 'Run it', status: 'pending' },
          ],
        },
      },
      {
        id: 'plan-1',
        toolName: 'ExitPlanMode',
        input: { plan: '# Python Hello-World Plan', name: 'python-hello-plan', overview: '', isProject: false },
      },
    ]);
    expect(result).toEqual({ accepted: true });
  });

  it('flattens create_plan phases (no flat todos) into the checklist with phase-name prefixes', async () => {
    const permissionHandler = new CapturingPermissionHandler({ decision: 'approved' });

    await invokeCursorExtension({
      handlers: buildCursorExtensionHandlers({ permissionHandler }),
      kind: 'request',
      method: 'cursor/create_plan',
      payload: {
        toolCallId: 'plan-2',
        plan: '# Plan',
        phases: [
          { name: 'Setup', todos: [{ id: 'a', content: 'Init repo', status: 'pending' }] },
          { name: 'Build', todos: [{ id: 'b', content: 'Compile', status: 'in_progress' }] },
        ],
      },
      context: { method: 'cursor/create_plan', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' },
    });

    expect(permissionHandler.calls[0]).toEqual({
      id: 'plan-2-todos',
      toolName: 'TodoWrite',
      input: {
        todos: [
          { id: 'a', content: '[Setup] Init repo', status: 'pending' },
          { id: 'b', content: '[Build] Compile', status: 'in_progress' },
        ],
      },
    });
  });

  it('preserves the cancelled todo status (4th Cursor status, absent from ACP plan spec)', () => {
    expect(buildCursorTodoWriteInput({
      todos: [
        { id: '1', content: 'Done thing', status: 'completed' },
        { id: '2', content: 'Abandoned thing', status: 'cancelled' },
        { id: '3', content: 'Also abandoned', status: 'canceled' },
      ],
    })).toEqual({
      todos: [
        { id: '1', content: 'Done thing', status: 'completed' },
        { id: '2', content: 'Abandoned thing', status: 'cancelled' },
        { id: '3', content: 'Also abandoned', status: 'cancelled' },
      ],
    });
  });

  it('merges update_todos snapshots by id when merge is set', async () => {
    const permissionHandler = new CapturingPermissionHandler();
    const handlers = buildCursorExtensionHandlers({ permissionHandler });
    const ctx = { method: 'cursor/update_todos', sessionId: 's1', signal: new AbortController().signal, agentName: 'cursor' };

    await invokeCursorExtension({
      handlers,
      kind: 'notification',
      method: 'cursor/update_todos',
      payload: {
        toolCallId: 'todos-1',
        todos: [
          { id: '1', content: 'First', status: 'pending' },
          { id: '2', content: 'Second', status: 'pending' },
        ],
      },
      context: ctx,
    });

    await invokeCursorExtension({
      handlers,
      kind: 'notification',
      method: 'cursor/update_todos',
      payload: {
        toolCallId: 'todos-2',
        merge: true,
        todos: [
          { id: '2', content: 'Second', status: 'completed' },
          { id: '3', content: 'Third', status: 'in_progress' },
        ],
      },
      context: ctx,
    });

    // The merged snapshot keeps #1 (untouched), updates #2, and appends #3 in first-seen order.
    expect(permissionHandler.calls[1].input).toEqual({
      todos: [
        { id: '1', content: 'First', status: 'pending' },
        { id: '2', content: 'Second', status: 'completed' },
        { id: '3', content: 'Third', status: 'in_progress' },
      ],
    });
  });
});

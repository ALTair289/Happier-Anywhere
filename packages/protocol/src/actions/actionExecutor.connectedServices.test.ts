import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    sessionSpawnPicker: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  };
}

describe('createActionExecutor connected-services selection', () => {
  it('normalizes a simple codex pool selection on subagents.delegate.start into canonical group bindings', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'Do the thing.',
        connectedServices: 'openai-codex:group:happier',
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
          },
        },
      }),
      undefined,
    );
  });

  it('lets a per-target override win over the blanket connectedServices', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'Do the thing.',
        connectedServices: 'openai-codex:team',
        connectedServicesByBackendTargetKey: { 'agent:codex': 'openai-codex:group:happier' },
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
          },
        },
      }),
      undefined,
    );
  });

  it('normalizes a simple profile selection on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start',
      {
        sessionId: 's1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Do the thing.',
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        connectedServices: 'openai-codex:team',
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
          },
        },
      }),
      undefined,
    );
  });

  it('rejects a malformed selection with invalid_parameters and never starts the run', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'Do the thing.',
        connectedServices: 'not-a-service:team',
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.errorCode).toBe('invalid_parameters');
    expect(executionRunStart).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';

const SELECTION: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
  },
};

const OVERRIDES = { v: 1 as const, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } };

function createResumableBackend() {
  let handler: AgentMessageHandler | null = null;
  const backend: AgentBackend = {
    async startSession(): Promise<StartSessionResult> {
      return { sessionId: 'child_1' as SessionId };
    },
    async loadSessionWithReplayCapture(_id: SessionId): Promise<StartSessionResult & { replay: unknown[] }> {
      return { sessionId: 'child_1' as SessionId, replay: [] };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {},
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
  return { backend, getHandler: () => handler };
}

describe('ExecutionRunManager — resume rehydrates the immutable launch record', () => {
  it('re-materializes the SAME CS account and re-applies model/effort/runId isolation after disposal', async () => {
    const createBackendCalls: Array<Record<string, unknown>> = [];
    const cleanup = vi.fn(async () => undefined);
    const prepareConnectedServices = vi.fn(
      async (_params: { backendTarget: unknown; connectedServices: unknown; sessionId: string }) => ({
        env: { CODEX_HOME: '/resume/root/codex-home' },
        materializationKey: 'execution_run:resume',
        cleanup,
        selection: SELECTION,
      }),
    );

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: '/tmp/wt',
      createBackend: (opts) => {
        createBackendCalls.push(opts as Record<string, unknown>);
        return createResumableBackend().backend;
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
      resolveAccountSettings: async () => ({ codexBackendMode: 'appServer' }),
      prepareConnectedServices,
    });

    const started = await manager.start({
      sessionId: 'parent_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: OVERRIDES,
      connectedServicesSelection: SELECTION,
      connectedServicesEnv: { CODEX_HOME: '/start/root/codex-home' },
    });

    // Dispose the backend + drop the controller (as a real stop / crash would).
    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);

    const beforeResumeCalls = createBackendCalls.length;

    const resumed = await manager.send(started.runId, { message: 'continue', resume: true });
    expect(resumed.ok).toBe(true);

    // A fresh backend was created for the resume.
    expect(createBackendCalls.length).toBe(beforeResumeCalls + 1);
    const resumeOpts = createBackendCalls.at(-1)!;
    expect(resumeOpts).toMatchObject({
      runId: started.runId,
      backendId: 'codex',
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: OVERRIDES,
      // Re-materialized CS account env (NOT the runner's ambient auth).
      connectedServicesEnv: { CODEX_HOME: '/resume/root/codex-home' },
    });
    // The persisted selection was re-materialized verbatim (same account/profile).
    expect(prepareConnectedServices).toHaveBeenCalledTimes(1);
    expect(prepareConnectedServices.mock.calls[0]?.[0]).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: SELECTION,
      sessionId: 'parent_1',
    });
  });

  it('fails closed on resume when the persisted CS account cannot be re-materialized', async () => {
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: '/tmp/wt',
      createBackend: () => createResumableBackend().backend,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
      resolveAccountSettings: async () => null,
      prepareConnectedServices: async () => {
        const { ExecutionRunConnectedServicesUnavailableError } = await import(
          '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices'
        );
        throw new ExecutionRunConnectedServicesUnavailableError({ agentId: 'codex' });
      },
    });

    const started = await manager.start({
      sessionId: 'parent_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      connectedServicesSelection: SELECTION,
      connectedServicesEnv: { CODEX_HOME: '/start/root/codex-home' },
    });

    await manager.stop(started.runId);
    await manager.waitForTerminal(started.runId);

    const resumed = await manager.send(started.runId, { message: 'continue', resume: true });
    expect(resumed.ok).toBe(false);
    expect(resumed.errorCode).toBe('execution_run_connected_services_unavailable');
  });
});

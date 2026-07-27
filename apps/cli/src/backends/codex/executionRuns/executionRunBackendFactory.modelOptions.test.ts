import { afterEach, describe, expect, it, vi } from 'vitest';

const { probeCodexAppServerExecutionRunAvailabilityMock } = vi.hoisted(() => ({
  probeCodexAppServerExecutionRunAvailabilityMock: vi.fn(() => true),
}));

vi.mock('./probeCodexAppServerExecutionRunAvailability', () => ({
  probeCodexAppServerExecutionRunAvailability: probeCodexAppServerExecutionRunAvailabilityMock,
}));

function createSpyBackend() {
  const setSessionModel = vi.fn(async () => undefined);
  const setSessionConfigOption = vi.fn(async () => undefined);
  const startSession = vi.fn(async () => ({ sessionId: 'sess-1' }));
  const loadSession = vi.fn(async () => ({ sessionId: 'sess-loaded' }));
  const backend = {
    startSession,
    loadSession,
    sendPrompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onMessage: vi.fn(),
    dispose: vi.fn(async () => undefined),
    setSessionModel,
    setSessionConfigOption,
  };
  return { backend, setSessionModel, setSessionConfigOption, startSession, loadSession };
}

const OVERRIDES = {
  v: 1 as const,
  updatedAt: 1,
  overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
};

describe('executionRunBackendFactory (codex) — per-run model + effort across transports', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    probeCodexAppServerExecutionRunAvailabilityMock.mockImplementation(() => true);
  });

  it('appServer (default): applies modelId + reasoning_effort after startSession', async () => {
    const spy = createSpyBackend();
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: () => spy.backend,
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');
    const backend = executionRunBackendFactory({
      cwd: '/tmp/wt',
      backendId: 'codex',
      permissionMode: 'read_only',
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: OVERRIDES,
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
      isolation: { env: { PATH: '/usr/bin' } },
    } as any);

    await backend.startSession();
    expect(spy.setSessionModel).toHaveBeenCalledWith('sess-1', 'gpt-5.5');
    expect(spy.setSessionConfigOption).toHaveBeenCalledWith('sess-1', 'reasoning_effort', 'high');
  });

  it('appServer: applies options after loadSession (resume) too', async () => {
    const spy = createSpyBackend();
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: () => spy.backend,
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');
    const backend = executionRunBackendFactory({
      cwd: '/tmp/wt',
      backendId: 'codex',
      permissionMode: 'read_only',
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: OVERRIDES,
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
      isolation: { env: { PATH: '/usr/bin' } },
    } as any);

    await backend.loadSession!('vendor-1' as any);
    expect(spy.setSessionModel).toHaveBeenCalledWith('sess-loaded', 'gpt-5.5');
    expect(spy.setSessionConfigOption).toHaveBeenCalledWith('sess-loaded', 'reasoning_effort', 'high');
  });

  it('ACP fallback: applies modelId + reasoning_effort after startSession', async () => {
    const spy = createSpyBackend();
    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: () => ({ backend: spy.backend }),
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: () => ({ ok: true }),
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');
    const backend = executionRunBackendFactory({
      cwd: '/tmp/wt',
      backendId: 'codex',
      permissionMode: 'read_only',
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: OVERRIDES,
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
      isolation: { env: { PATH: '/usr/bin', HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp' } },
    } as any);

    await backend.startSession();
    expect(spy.setSessionModel).toHaveBeenCalledWith('sess-1', 'gpt-5.5');
    expect(spy.setSessionConfigOption).toHaveBeenCalledWith('sess-1', 'reasoning_effort', 'high');
  });

  it('MCP: receives modelId + derived reasoningEffort at construction', async () => {
    const mcpCalls: Array<Record<string, unknown>> = [];
    vi.doMock('./createCodexMcpExecutionRunBackend', () => ({
      createCodexMcpExecutionRunBackend: (options: Record<string, unknown>) => {
        mcpCalls.push(options);
        return { startSession: async () => ({ sessionId: 'mcp' }), dispose: async () => undefined, onMessage: () => undefined, sendPrompt: async () => undefined, cancel: async () => undefined };
      },
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');
    executionRunBackendFactory({
      cwd: '/tmp/wt',
      backendId: 'codex',
      permissionMode: 'read_only',
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: {
        ...OVERRIDES,
        overrides: { reasoning_effort: { updatedAt: 1, value: ' high\t' } },
      },
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
      isolation: { env: { PATH: '/usr/bin', HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'mcp' } },
    } as any);

    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0]).toMatchObject({ modelId: 'gpt-5.5', reasoningEffort: ' high\t' });
  });
});

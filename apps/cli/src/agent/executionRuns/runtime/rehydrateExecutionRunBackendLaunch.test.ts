import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { ExecutionRunConnectedServicesUnavailableError } from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';
import { resolveExecutionRunResumeBackendOptions } from '@/agent/executionRuns/runtime/rehydrateExecutionRunBackendLaunch';

const CONNECTED_SELECTION: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
  },
};

function baseRun(launch: ExecutionRunState['launch']): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sc_1',
    sessionId: 'sess_1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'cancelled',
    startedAtMs: 1,
    ...(launch ? { launch } : {}),
  };
}

describe('resolveExecutionRunResumeBackendOptions', () => {
  it('re-resolves account settings + re-materializes the SAME persisted CS selection and threads model/effort', async () => {
    const cleanup = vi.fn(async () => undefined);
    const prepareConnectedServices = vi.fn(
      async (_params: { backendTarget: unknown; connectedServices: unknown; sessionId: string }) => ({
        env: { CODEX_HOME: '/run/root/codex-home' },
        materializationKey: 'execution_run:x',
        cleanup,
        selection: CONNECTED_SELECTION,
      }),
    );
    const overrides = { v: 1 as const, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } };

    const options = await resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides, connectedServicesSelection: CONNECTED_SELECTION }),
      resolveAccountSettings: async () => ({ codexBackendMode: 'appServer' }),
      prepareConnectedServices,
    });

    expect(prepareConnectedServices).toHaveBeenCalledTimes(1);
    // The persisted selection is re-materialized verbatim (same account/profile).
    expect(prepareConnectedServices.mock.calls[0]?.[0]).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: CONNECTED_SELECTION,
      sessionId: 'sess_1',
    });
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.sessionConfigOptionOverrides).toEqual(overrides);
    expect(options.accountSettings).toEqual({ codexBackendMode: 'appServer' });
    expect(options.connectedServicesEnv).toEqual({ CODEX_HOME: '/run/root/codex-home' });
    expect(options.connectedServicesCleanup).toBe(cleanup);
  });

  it('fails closed when a connected selection was persisted but no CS rehydrator is available', async () => {
    await expect(
      resolveExecutionRunResumeBackendOptions({
        run: baseRun({ connectedServicesSelection: CONNECTED_SELECTION }),
        resolveAccountSettings: async () => null,
        // prepareConnectedServices intentionally omitted.
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
  });

  it('fails closed when re-materialization returns nothing for a persisted connected selection', async () => {
    await expect(
      resolveExecutionRunResumeBackendOptions({
        run: baseRun({ connectedServicesSelection: CONNECTED_SELECTION }),
        resolveAccountSettings: async () => null,
        prepareConnectedServices: async () => null,
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
  });

  it('does not materialize CS when the launch record had no connected selection', async () => {
    const prepareConnectedServices = vi.fn(async () => null);
    const options = await resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: 'gpt-5.5' }),
      resolveAccountSettings: async () => null,
      prepareConnectedServices,
    });
    expect(prepareConnectedServices).not.toHaveBeenCalled();
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.connectedServicesEnv).toBeUndefined();
  });
});

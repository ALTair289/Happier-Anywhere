import { describe, expect, it, vi } from 'vitest';

import type { CatalogAgentId } from '@/backends/types';
import { agent as openCodeAgent } from '@/backends/opencode';
import { agent as piAgent } from '@/backends/pi';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { TrackedSession } from '@/daemon/types';
import { createConnectedServicesAuthUpdatedRestartHandler } from './createConnectedServicesAuthUpdatedRestartHandler';

const directLiveExternalTokenInjectionCapability = {
  supportsInTurnApply: true,
  requiresExactRuntimeIdentity: true,
  refreshSelectionResync: 'required',
  authMode: {
    kind: 'external_token_injection',
    surface: 'codex_chatgpt_auth_tokens',
  },
} as const;

describe('createConnectedServicesAuthUpdatedRestartHandler', () => {
  type RestartHandlerParams = Parameters<typeof createConnectedServicesAuthUpdatedRestartHandler>[0];
  type RestartSignalParams = Parameters<RestartHandlerParams['requestRestartSignal']>[0];

  function createTrackedSession(input: Readonly<{
    pid: number;
    sessionId: string;
    startedBy?: TrackedSession['startedBy'];
  }>): TrackedSession {
    return {
      pid: input.pid,
      startedBy: input.startedBy ?? 'daemon',
      happySessionId: input.sessionId,
    };
  }

  function createLifecycleDescriptor(
    agentId: CatalogAgentId,
    mode: 'restart_required' | 'no_restart_required',
  ): ConnectedServiceCredentialLifecycleDescriptor {
    return {
      providerId: agentId,
      serviceIds: ['claude-subscription'],
      spawnPreflightOauthRefresh: { mode: 'expiry_window' },
      refreshedCredentialApplication: { mode },
      predictiveSoftSwitch: { mode: agentId === 'codex' ? 'supported' : 'unsupported' },
      sameAccountFanoutStrategy: agentId === 'codex' ? 'provider_account_id' : 'none',
      runtimeAuthApply: {
        directLiveHotAuth: agentId === 'codex'
          ? directLiveExternalTokenInjectionCapability
          : 'unsupported',
      },
    };
  }

  it('marks restart-required targets and requests a restart signal without killing the child directly', async () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
      [2, createTrackedSession({ pid: 2, sessionId: 's2' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, agentId === 'claude' ? 'restart_required' : 'no_restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [
        { pid: 1, agentId: 'claude' },
        { pid: 2, agentId: 'codex' },
      ],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
    expect(restartRequestedPids.has(2)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      processGroupPid: 1,
      delayMs: 250,
      restartDiagnostic: expect.objectContaining({
        trigger: 'refresh_triggered_restart',
        sessionId: 's1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 7,
      }),
    }));
  });

  it('does not restart OpenCode or Pi for brokered same-account OAuth refreshes', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'opencode-session' })],
      [2, createTrackedSession({ pid: 2, sessionId: 'pi-session' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'opencode') return await openCodeAgent.getConnectedServiceCredentialLifecycleDescriptor();
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [
        { pid: 1, agentId: 'opencode' },
        { pid: 2, agentId: 'pi' },
      ],
      trigger: 'refresh_triggered_restart',
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });

  it('still restarts OpenCode when a direct API-key connected service is reconnected', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'opencode-session' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'opencode') return await openCodeAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai', profileId: 'platform-key' },
      affectedTargets: [{ pid: 1, agentId: 'opencode' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('passes the resolved tracked session and gated-restart target to the restart-signal dependency (K3)', async () => {
    // K3: the wiring site routes the restart through the gated deferral primitive
    // (requestConnectedServiceRestartWithDeferral), which needs the tracked
    // session + the switch target descriptor. The handler must therefore hand
    // both to its requestRestartSignal dependency instead of only a bare pid.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      tracked,
      sessionId: 's1',
      target: {
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 9,
      },
    }));
  });

  it('marks external credential updates as reconnect propagation restart diagnostics', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 4 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      restartDiagnostic: expect.objectContaining({
        trigger: 'reconnect_propagation',
        sessionId: 's1',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      }),
    }));
  });

  it('classifies refresh and reconnect propagation as non-account-changing gated restarts', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 4 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      tracked,
      target: {
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      },
      restartDiagnostic: expect.objectContaining({
        trigger: 'reconnect_propagation',
        reason: 'reconnect_propagation',
      }),
    }));
  });

  it('does not reserve the pid when the gated restart returns WITHOUT signalling (switch_cancelled must not leak the reservation)', async () => {
    // Regression: the handler used to reserve the pid in restartRequestedPids BEFORE awaiting the
    // gated restart dependency. When the deferred restart is superseded by a newer switch the
    // dependency returns success WITHOUT signalling (no onSignalFailure, no throw). The pid then
    // stayed reserved forever, suppressing every later refresh restart for that process until exit.
    // The dependency now reports whether it actually signalled; an un-signalled restart must leave
    // the pid UNRESERVED so a subsequent refresh can restart it.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: false }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(1)).toBe(false);

    // A later refresh for the SAME pid must NOT be suppressed (the reservation did not leak).
    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 10 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });
    expect(requestRestartSignal).toHaveBeenCalledTimes(2);
  });

  it('reserves the pid only when the gated restart actually signalled', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not double-restart the same pid', async () => {
    const restartRequestedPids = new Set<number>([1]);
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(0);
  });

  it('does not mark the pid for restart when restart signaling throws', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => {
      throw new Error('kill-failed');
    });
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    })).resolves.toBeUndefined();

    expect(restartRequestedPids.size).toBe(0);
  });

  it('records a blocked diagnostic when a restart-required target cannot be safely signaled', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const onRestartBlocked = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
      onRestartBlocked,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
    expect(onRestartBlocked).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      agentId: 'claude',
      pid: 1,
      reason: 'unsupported_restart_signal',
      startedBy: 'daemon',
      hasChildProcess: false,
      hasProcessGroupPid: false,
      reattachedFromDiskMarker: false,
    });
  });
});

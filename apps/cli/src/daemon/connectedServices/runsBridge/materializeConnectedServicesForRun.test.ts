import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import {
  ExecutionRunConnectedServiceMaterializeError,
  createExecutionRunConnectedServicesBridge,
  type ResolveConnectedServiceAuthForRun,
} from './materializeConnectedServicesForRun';

const RUN_KEY = 'execution_run:run_codex_1';

function buildResolved(cleanupOnExit: (() => void) | null = null) {
  return {
    env: { CODEX_HOME: '/materialized/run/codex/codex-home' },
    cleanupOnFailure: null,
    cleanupOnExit,
    connectedServicesBindings: {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      },
    },
    runtimeAccountIdentitySelections: [],
  };
}

function buildRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    runId: 'run_codex_1',
    agentId: 'codex' as const,
    pid: 4242,
    materializationKey: RUN_KEY,
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    },
    sessionDirectory: '/tmp/workspace',
    ...overrides,
  };
}

describe('createExecutionRunConnectedServicesBridge', () => {
  it('materializes via the spawn resolver, registers the run in the run keyspace, and returns the env', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const resolveAuthForSpawn = vi.fn(async (_input: unknown) => buildResolved());
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: resolveAuthForSpawn as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const result = await bridge.materialize(buildRequest());

    expect(result.env).toEqual({ CODEX_HOME: '/materialized/run/codex/codex-home' });
    expect(resolveAuthForSpawn.mock.calls.at(0)?.[0]).toMatchObject({
      agentId: 'codex',
      materializationKey: RUN_KEY,
      sessionDirectory: '/tmp/workspace',
    });
    // The run is covered by refresh redistribution via the run keyspace (not the pid map).
    const refreshTargets = registry.listRefreshTargets();
    expect(refreshTargets.map((target) => target.materializationKey)).toEqual([RUN_KEY]);
    expect(refreshTargets[0]?.agentId).toBe('codex');
    expect(refreshTargets[0]?.pid).toBe(4242);
  });

  it('R3-1: coexists with an existing session target on the same PID — BOTH covered by refresh distribution', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'session-1',
      materializationKey: 'session-key-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'a' },
        },
      },
    });
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved()) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const result = await bridge.materialize(buildRequest());

    expect(result.env).toEqual({ CODEX_HOME: '/materialized/run/codex/codex-home' });
    // The session pid target is untouched…
    const sessionTarget = registry.getByPid(4242);
    expect(sessionTarget?.materializationKey).toBe('session-key-1');
    expect(sessionTarget?.agentId).toBe('claude');
    // …and the run target coexists on the same pid — a rotation's redistribution now reaches BOTH.
    const refreshKeys = registry.listRefreshTargets().map((target) => target.materializationKey).sort();
    expect(refreshKeys).toEqual([RUN_KEY, 'session-key-1']);
  });

  it('NF-1: indexes the run target by its broker selection identity so a broker refresh authorizes it', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(),
        env: { OPENCODE_SERVER: 'http://x', HAPPIER_OPENCODE_BROKER_SELECTION_IDENTITY: 'oc-pool-x' },
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      resolveBrokerSelectionIdentity: (env) => env['HAPPIER_OPENCODE_BROKER_SELECTION_IDENTITY'] ?? null,
    });

    await bridge.materialize(buildRequest({ agentId: 'opencode' }));

    // No live session shares the pool, yet the run is resolvable by its broker selection identity.
    const resolved = registry.getByBrokerSelectionIdentity('oc-pool-x');
    expect(resolved?.materializationKey).toBe(RUN_KEY);

    // Released on run end — no cross-run authorize of a dead run.
    await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(registry.getByBrokerSelectionIdentity('oc-pool-x')).toBeNull();
  });

  it('fails CLOSED (typed error, no registration) when the resolver yields no selection', async () => {
    // POST-WAVE-REVIEW F1: the runner only calls materialize when a CS selection was prepared, so
    // an unresolved selection here means the run would silently proceed on the runner's INHERITED
    // account — a fail-open identity hazard. It must reject instead (dev-parity).
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => null) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await expect(bridge.materialize(buildRequest())).rejects.toMatchObject({
      code: 'execution_run_connected_service_materialization_failed',
    });
    expect(registry.getByPid(4242)).toBeNull();
  });

  it('fails CLOSED with a typed error when resolution throws', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => {
        throw new Error('materialization exploded');
      }) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await expect(bridge.materialize(buildRequest())).rejects.toBeInstanceOf(ExecutionRunConnectedServiceMaterializeError);
    expect(registry.getByPid(4242)).toBeNull();
  });

  it('release unregisters the run target and runs the materialized-root cleanup exactly once', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanupOnExit = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved(cleanupOnExit)) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await bridge.materialize(buildRequest());
    expect(registry.listRefreshTargets().map((target) => target.materializationKey)).toEqual([RUN_KEY]);

    const released = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(released.released).toBe(true);
    expect(registry.listRefreshTargets()).toEqual([]);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);

    // Idempotent: a second release is a no-op.
    const again = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(again.released).toBe(false);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
  });

  it('release removes the run-scoped materialized root even when the materializer reported no cleanupOnExit', async () => {
    // The codex materializer (persistent session roots) returns cleanupOnExit:null — run roots are
    // uuid-keyed and would otherwise accumulate forever. Release derives the root cleanup from the
    // materialized env via the canonical createConnectedServiceMaterializedTargetRootCleanup owner.
    const runRoot = await mkdtemp(join(tmpdir(), 'happier-er-cs-run-root-'));
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(null),
        env: {
          CODEX_HOME: join(runRoot, 'codex-home'),
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: runRoot,
        },
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await bridge.materialize(buildRequest());
    const released = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(released.released).toBe(true);

    // The root-cleanup owner fires rm without awaiting; poll briefly for the removal.
    await expect.poll(async () => {
      try {
        await stat(runRoot);
        return 'exists';
      } catch {
        return 'removed';
      }
    }, { timeout: 2_000 }).toBe('removed');
  });

  it('A1: a release racing an in-flight materialize still reclaims the late daemon-side success', async () => {
    // Client-abandonment shape: the runner timed out and fired release while the daemon's materialize
    // was still resolving. Release must serialize behind the in-flight materialize so the late success
    // (root + registered target) is reclaimed instead of leaking.
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanupOnExit = vi.fn();
    let resolveMaterialization!: () => void;
    const materializationGate = new Promise<void>((resolve) => {
      resolveMaterialization = resolve;
    });
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => {
        await materializationGate;
        return buildResolved(cleanupOnExit);
      }) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const materializePromise = bridge.materialize(buildRequest());
    const releasePromise = bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });

    // Let the release call arrive while the materialization is still pending, then finish it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveMaterialization();

    const [, released] = await Promise.all([materializePromise, releasePromise]);
    expect(released.released).toBe(true);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    expect(registry.listRefreshTargets()).toEqual([]);
  });

  it('logs materialize + release diagnostics WITHOUT ever emitting env values/tokens (QA2-F01)', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanupOnExit = vi.fn();
    const info = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved(cleanupOnExit)) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      logger: { info },
    });

    await bridge.materialize(buildRequest());
    await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });

    const materializeLog = info.mock.calls.find((call) => String(call[0]).includes('materialized'));
    expect(materializeLog?.[1]).toMatchObject({
      runId: 'run_codex_1',
      agentId: 'codex',
      materializationKey: RUN_KEY,
      registered: true,
      envKeyCount: 1,
    });

    const releaseLog = info.mock.calls.find((call) => String(call[0]).includes('released'));
    expect(releaseLog?.[1]).toMatchObject({ runId: 'run_codex_1', released: true, cleanupRan: true });

    // Values-never-logged: the materialized env VALUE (a home path / would be a token) must never
    // appear anywhere in the emitted diagnostics.
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain('/materialized/run/codex/codex-home');
  });

  it('records registered:true even when a session target shares the pid (run keyspace, R3-1)', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'session-1',
      materializationKey: 'session-key-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'a' },
        },
      },
    });
    const info = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved()) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      logger: { info },
    });

    await bridge.materialize(buildRequest());

    const materializeLog = info.mock.calls.find((call) => String(call[0]).includes('materialized'));
    // The run keyspace means a same-pid session no longer forces a coverage skip.
    expect(materializeLog?.[1]).toMatchObject({ registered: true });
    const refreshKeys = registry.listRefreshTargets().map((target) => target.materializationKey).sort();
    expect(refreshKeys).toEqual([RUN_KEY, 'session-key-1']);
  });

  it('release never unregisters a target owned by a different materialization (session target stays)', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'session-1',
      materializationKey: 'session-key-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'a' },
        },
      },
    });
    const cleanupOnExit = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved(cleanupOnExit)) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await bridge.materialize(buildRequest());
    const released = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });

    // Root cleanup still runs (the run's materialized root is run-owned)…
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    expect(released.released).toBe(true);
    // …but the session's registration is untouched.
    expect(registry.getByPid(4242)?.materializationKey).toBe('session-key-1');
  });
});

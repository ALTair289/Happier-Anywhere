import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import {
  ConnectedServiceRuntimeRegistry,
  readConnectedServiceRuntimeTargetIdentity,
} from './registry';

const connectedServicesBindingsRaw = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'group',
      groupId: 'team',
      profileId: 'codex-a',
    },
  },
} as const;

const connectedServiceSelectionsEnv = {
  [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
    kind: 'group',
    serviceId: 'openai-codex',
    groupId: 'team',
    activeProfileId: 'codex-a',
    fallbackProfileId: 'codex-b',
    generation: 7,
  }]),
} as const;

function registerFullTarget(registry: ConnectedServiceRuntimeRegistry) {
  return registry.registerTarget({
    pid: 42,
    agentId: 'codex',
    sessionId: 'sess-a',
    connectedServicesBindingsRaw,
    connectedServiceSelectionsEnv,
    materializationKey: 'csm_runtime_registry',
    connectedServiceMaterializationIdentityV1: {
      v: 1,
      id: 'csm_runtime_registry',
      createdAtMs: 1_000,
    },
    sessionDirectory: '/workspace/a',
  });
}

describe('ConnectedServiceRuntimeRegistry', () => {
  it('registers, updates, and unregisters targets across pid and session indexes', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    const registered = registerFullTarget(registry);

    expect(registered.revision).toBe(1);
    expect(registry.getByPid(42)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(42);

    const updated = registry.updateTarget({
      pid: 42,
      sessionId: 'sess-b',
      sessionDirectory: '/workspace/b',
    });

    expect(updated?.revision).toBe(2);
    expect(registry.getByPid(42)?.sessionDirectory).toBe('/workspace/b');
    expect(registry.getBySessionId('sess-a')).toBeNull();
    expect(registry.getBySessionId('sess-b')?.pid).toBe(42);

    const unregistered = registry.unregisterPid(42);

    expect(unregistered?.pid).toBe(42);
    expect(registry.getByPid(42)).toBeNull();
    expect(registry.getBySessionId('sess-b')).toBeNull();
  });

  it('transfers a target to a promoted pid without losing its session identity', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registerFullTarget(registry);

    const transferred = registry.transferPid(42, 84);

    expect(transferred?.pid).toBe(84);
    expect(transferred?.sessionId).toBe('sess-a');
    expect(transferred?.revision).toBe(2);
    expect(registry.getByPid(42)).toBeNull();
    expect(registry.getByPid(84)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(84);
  });

  it('replaces the old pid entry when the same session reattaches under a new pid', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registerFullTarget(registry);

    const reattached = registry.registerTarget({
      pid: 84,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_runtime_registry',
      sessionDirectory: '/workspace/a',
    });

    expect(reattached.pid).toBe(84);
    expect(registry.getByPid(42)).toBeNull();
    expect(registry.getByPid(84)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(84);
    expect(registry.listTargets().map((target) => target.pid)).toEqual([84]);
    expect(registry.listRefreshTargets().map((target) => target.pid)).toEqual([84]);
    expect(registry.listQuotaTargets().map((target) => target.pid)).toEqual([84]);
  });

  it('adopts a session id onto a target and updates both consumer views atomically', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_runtime_registry',
    });

    const adopted = registry.adoptSessionId({ pid: 42, sessionId: 'sess-adopted' });

    expect(adopted?.sessionId).toBe('sess-adopted');
    expect(registry.getBySessionId('sess-adopted')?.pid).toBe(42);
    expect(registry.listRefreshTargets()[0]?.sessionId).toBe('sess-adopted');
    expect(registry.listQuotaTargets()[0]?.sessionId).toBe('sess-adopted');
  });

  it('does not bump the revision for unchanged reattach updates', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const registered = registerFullTarget(registry);

    const unchanged = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_runtime_registry',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_runtime_registry',
        createdAtMs: 1_000,
      },
      sessionDirectory: '/workspace/a',
    });

    expect(unchanged.revision).toBe(registered.revision);
    expect(unchanged).toBe(registered);
  });

  it('exposes the same connected-service runtime identity to refresh and quota views', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registerFullTarget(registry);

    const refreshTarget = registry.listRefreshTargets()[0];
    const quotaTarget = registry.listQuotaTargets()[0];

    expect(refreshTarget).toBeDefined();
    expect(quotaTarget).toBeDefined();
    expect(refreshTarget?.runtimeIdentityKey).toBe(quotaTarget?.runtimeIdentityKey);
    expect(readConnectedServiceRuntimeTargetIdentity(refreshTarget!)).toEqual(
      readConnectedServiceRuntimeTargetIdentity(quotaTarget!),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { registerConnectedServiceRuntimeTargetForDaemon } from './runtimeTargetRegistration';

/**
 * RR-8: the `successful_spawn` positive-evidence emit is wired through this registration seam via
 * `onRegisteredTarget`. It must fire (with the freshly registered target) exactly when a
 * connected-service target is registered, and never for spawns without connected-service data.
 */
describe('registerConnectedServiceRuntimeTargetForDaemon onRegisteredTarget', () => {
  const connectedBindings = {
    v: 1 as const,
    bindingsByServiceId: { 'claude-subscription': { source: 'connected' as const, profileId: 'work' } },
  };

  it('invokes onRegisteredTarget with the registered target for a connected-service spawn', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();

    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4321,
      agentId: 'claude',
      sessionId: 'sess-spawn-evidence',
      connectedServicesBindingsRaw: connectedBindings,
      materializationKey: 'mk-spawn-evidence',
      onRegisteredTarget,
    });

    expect(onRegisteredTarget).toHaveBeenCalledTimes(1);
    expect(onRegisteredTarget).toHaveBeenCalledWith(expect.objectContaining({ pid: 4321, agentId: 'claude' }));
  });

  it('does not invoke onRegisteredTarget when there is no connected-service registration data', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();

    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4322,
      agentId: 'claude',
      sessionId: 'sess-no-cs',
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
      onRegisteredTarget,
    });

    expect(onRegisteredTarget).not.toHaveBeenCalled();
  });

  it('does not invoke onRegisteredTarget without a registry', () => {
    const onRegisteredTarget = vi.fn();
    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: null,
      pid: 4323,
      connectedServicesBindingsRaw: connectedBindings,
      onRegisteredTarget,
    });
    expect(onRegisteredTarget).not.toHaveBeenCalled();
  });
});

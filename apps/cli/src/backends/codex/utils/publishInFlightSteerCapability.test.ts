import { describe, expect, it } from 'vitest';

import type { AgentState } from '@/api/types';

describe('publishInFlightSteerCapability', () => {
  it('publishes inFlightSteer=true when runtime supports in-flight steer', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = {};
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = { supportsInFlightSteer: () => true };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any });

    expect(state.capabilities?.inFlightSteer).toBe(true);
    expect(state.capabilities?.inFlightSteerSupported).toBe(true);
  });

  it('publishes current in-flight steer availability when the runtime exposes it', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = {};
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = {
      supportsInFlightSteer: () => true,
      canSteerPrompt: () => false,
    };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any });

    expect(state.capabilities?.inFlightSteerSupported).toBe(true);
    expect(state.capabilities?.inFlightSteerAvailable).toBe(false);
  });

  it('publishes in-flight config apply support only when the runtime exposes it', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = { capabilities: { inFlightConfigApplySupported: true } };
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };

    publishInFlightSteerCapability({
      session: session as any,
      runtime: {
        supportsInFlightSteer: () => true,
        supportsInFlightConfigApply: () => true,
      } as any,
    });

    expect(state.capabilities?.inFlightConfigApplySupported).toBe(true);

    publishInFlightSteerCapability({
      session: session as any,
      runtime: {
        supportsInFlightSteer: () => true,
      } as any,
    });

    expect(state.capabilities?.inFlightConfigApplySupported).toBe(false);
  });

  it('publishes inFlightSteer=false when runtime does not support in-flight steer', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = { capabilities: { inFlightSteer: true } as any };
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = { supportsInFlightSteer: () => false };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any });

    expect(state.capabilities?.inFlightSteer).toBe(false);
    expect(state.capabilities?.inFlightSteerSupported).toBe(false);
  });
});

describe('publishInFlightSteerCapability — unavailable-reason seam (lane P, O-design Seam A)', () => {
  function capture() {
    let state: AgentState = {};
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    return { session, get state() { return state; } };
  }

  it('publishes backend_unsupported with a state timestamp when steering is unsupported', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');
    const captured = capture();

    publishInFlightSteerCapability({
      session: captured.session as any,
      runtime: { supportsInFlightSteer: () => false } as any,
    });

    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('backend_unsupported');
    expect(typeof captured.state.capabilities?.inFlightSteerStateAt).toBe('number');
  });

  it('publishes unsafe_window when supported but the current window cannot steer', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');
    const captured = capture();

    publishInFlightSteerCapability({
      session: captured.session as any,
      runtime: { supportsInFlightSteer: () => true, canSteerPrompt: () => false } as any,
    });

    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(false);
  });

  it('clears the reason when steering is available', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');
    const captured = capture();

    publishInFlightSteerCapability({
      session: captured.session as any,
      runtime: { supportsInFlightSteer: () => true, canSteerPrompt: () => true } as any,
    });

    expect(captured.state.capabilities?.inFlightSteerUnavailableReason ?? null).toBeNull();
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(true);
    expect(typeof captured.state.capabilities?.inFlightSteerStateAt).toBe('number');
  });
});

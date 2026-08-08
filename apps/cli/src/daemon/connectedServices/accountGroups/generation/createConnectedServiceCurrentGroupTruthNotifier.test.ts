import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceCurrentGroupTruthNotifier } from './createConnectedServiceCurrentGroupTruthNotifier';

describe('createConnectedServiceCurrentGroupTruthNotifier', () => {
  it('uses the provider catalog hook and retained apply-generation RPC to fence Claude producers', async () => {
    const callRpc = vi.fn(async () => ({ ok: true as const, appliedVia: 'current_truth_fence' as const }));
    const notify = createConnectedServiceCurrentGroupTruthNotifier({
      resolveTransport: async (sessionId) => ({ sessionId, runtime: 'claude' }),
      callRpc,
    });

    await expect(notify({
      sessionId: 'session-1',
      serviceId: 'claude-subscription',
      applicationOwnerId: 'claude',
      currentTruth: {
        kind: 'current_auth_group_unavailable',
        groupId: 'group-1',
        unavailableReason: 'group_missing',
      },
    })).resolves.toEqual({ ok: true });

    expect(callRpc).toHaveBeenCalledWith({
      transport: { sessionId: 'session-1', runtime: 'claude' },
      method: 'session-1:session.connectedServiceAuth.applyGeneration',
      request: {
        serviceId: 'claude-subscription',
        reason: 'diagnostic',
        authGeneration: {
          kind: 'current_auth_group_unavailable',
          groupId: 'group-1',
          unavailableReason: 'group_missing',
        },
      },
    });
  });

  it('updates the request-time broker authority instead of treating a missing RPC hook as success', async () => {
    const callRpc = vi.fn();
    const applyRequestTimeBrokerCurrentTruth = vi.fn(async () => ({ ok: true as const }));
    const notify = createConnectedServiceCurrentGroupTruthNotifier({
      resolveTransport: async (sessionId) => ({ sessionId }),
      callRpc,
      applyRequestTimeBrokerCurrentTruth,
    });

    await expect(notify({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      applicationOwnerId: 'opencode',
      currentTruth: {
        kind: 'current_auth_group_unavailable',
        groupId: 'group-1',
        unavailableReason: 'active_profile_missing',
      },
    })).resolves.toEqual({ ok: true });
    expect(applyRequestTimeBrokerCurrentTruth).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      applicationOwnerId: 'opencode',
      currentTruth: expect.objectContaining({ kind: 'current_auth_group_unavailable' }),
    }));
    expect(callRpc).not.toHaveBeenCalled();
  });

  it('marks only exact available application notifications as settled for the provider runtime', async () => {
    const callRpc = vi.fn(async () => ({ ok: true as const, appliedVia: 'current_truth_fence' as const }));
    const notify = createConnectedServiceCurrentGroupTruthNotifier({
      resolveTransport: async (sessionId) => ({ sessionId, runtime: 'claude' }),
      callRpc,
    });

    await expect(notify({
      sessionId: 'session-1',
      serviceId: 'claude-subscription',
      applicationOwnerId: 'claude',
      applicationSettled: true,
      currentTruth: {
        kind: 'current_auth_group_available',
        groupId: 'group-1',
        generation: 7,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    })).resolves.toEqual({ ok: true });

    expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ applicationSettled: true }),
    }));
  });

  it('does not deliver old current truth when the exact registration changes during transport resolution', async () => {
    let resolveTransport!: (transport: { sessionId: string }) => void;
    const transport = new Promise<{ sessionId: string }>((resolve) => {
      resolveTransport = resolve;
    });
    let isCurrent = true;
    const callRpc = vi.fn(async () => ({ ok: true as const, appliedVia: 'current_truth_fence' as const }));
    const notify = createConnectedServiceCurrentGroupTruthNotifier({
      resolveTransport: async () => await transport,
      callRpc,
    });
    const notification = notify({
      sessionId: 'same-session',
      serviceId: 'claude-subscription',
      applicationOwnerId: 'claude',
      isCurrent: () => isCurrent,
      currentTruth: {
        kind: 'current_auth_group_available',
        groupId: 'old-group',
        generation: 268,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      },
    });

    isCurrent = false;
    resolveTransport({ sessionId: 'same-session' });

    await expect(notification).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_target_registration_superseded',
    });
    expect(callRpc).not.toHaveBeenCalled();
  });
});

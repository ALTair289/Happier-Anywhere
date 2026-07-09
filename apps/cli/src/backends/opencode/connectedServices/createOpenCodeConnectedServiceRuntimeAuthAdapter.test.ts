import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { releaseForAuthSwitchMock } = vi.hoisted(() => ({
  releaseForAuthSwitchMock: vi.fn(async () => ({ released: true as const, reason: 'released' as const })),
}));

vi.mock('@/backends/opencode/server/sharedManagedServer', () => ({
  releaseForAuthSwitch: releaseForAuthSwitchMock,
}));

import {
  getBrokerBridgeEffectiveSelectionForTest,
  resetBrokerBridgeEffectiveSelectionsForTests,
} from '@/daemon/connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import {
  createOpenCodeConnectedServiceRuntimeAuthAdapter,
  resolveOpenCodeRuntimeAuthSelection,
} from './createOpenCodeConnectedServiceRuntimeAuthAdapter';

describe('createOpenCodeConnectedServiceRuntimeAuthAdapter', () => {
  beforeEach(() => {
    releaseForAuthSwitchMock.mockReset();
    releaseForAuthSwitchMock.mockResolvedValue({ released: true as const, reason: 'released' as const });
    resetBrokerBridgeEffectiveSelectionsForTests();
  });

  afterEach(() => {
    resetBrokerBridgeEffectiveSelectionsForTests();
  });

  it('releases the prior managed server after an auth switch when prior fingerprint context is present', async () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode' },
      selection: {
        serviceId: 'openai-codex',
        previousLaunchFingerprint: 'previous-fingerprint',
        previousOwnerToken: 'owner-token-1',
      },
    })).resolves.toMatchObject({
      recovered: true,
      recovery: 'restart_rematerialize',
      detached: true,
      detachedReason: 'released',
    });

    expect(releaseForAuthSwitchMock).toHaveBeenCalledWith('previous-fingerprint', 'owner-token-1');
  });

  it('does not try to release managed servers when prior fingerprint context is missing', async () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode' },
      selection: { serviceId: 'openai-codex' },
    })).resolves.toMatchObject({
      recovered: true,
      recovery: 'restart_rematerialize',
      detached: false,
      detachedReason: 'prior_launch_fingerprint_missing',
    });

    expect(releaseForAuthSwitchMock).not.toHaveBeenCalled();
  });

  it('does not classify usage-limit errors as connected-service incidents without a concrete OpenCode binding', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: { name: 'FreeUsageLimitError', message: 'rate limited' },
      selection: null,
    })).toBeNull();
  });

  it('reports restart-rematerialize adoption as weakly_verified — no live provider probe runs (RD-OPI-8)', async () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.verifyActiveAccount?.({
      target: { agentId: 'opencode' },
      selection: {},
    })).resolves.toEqual({
      status: 'weakly_verified',
      reason: 'provider_restart_rematerialization_authoritative',
    });
  });

  it('classifies OpenCode ProviderAuthError as auth_expired against the selected service (RD-OPI-6)', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'Unauthorized' } },
      selection: { kind: 'profile', serviceId: 'anthropic', profileId: 'anthropic-profile' },
    })).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'anthropic',
      profileId: 'anthropic-profile',
      source: 'structured_provider_error',
    });
  });

  it('classifies underlying-provider 401/invalid-key text surfaced through OpenCode as auth_expired with honest message provenance', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: new Error('provider request failed: 401 unauthorized — invalid api key'),
      selection: { kind: 'profile', serviceId: 'openai', profileId: 'openai-profile' },
    })).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai',
      profileId: 'openai-profile',
      source: 'stable_provider_message',
    });
  });

  it('classifies underlying-provider capacity/overload failures surfaced through OpenCode', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: { name: 'UnknownError', data: { message: 'The model is overloaded, please try again later' } },
      selection: { kind: 'profile', serviceId: 'anthropic', profileId: 'anthropic-profile' },
    })).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      serviceId: 'anthropic',
      source: 'stable_provider_message',
    });
  });

  it('labels heuristic retry-status classifications with stable_provider_message provenance (synthetic names are text-derived)', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: Object.assign(new Error('usage limit reached for today'), {
        name: 'FreeUsageLimitError',
        code: 'opencode_session_retry',
        type: 'opencode_session_retry',
        headers: { 'retry-after-ms': '2500' },
      }),
      selection: { kind: 'profile', serviceId: 'openai', profileId: 'openai-profile' },
    })).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      retryAfterMs: 2500,
      source: 'stable_provider_message',
    });
  });

  it('keeps structured provider usage-limit errors labelled structured_provider_error', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: { name: 'FreeUsageLimitError', message: 'usage limit reached' },
      selection: { kind: 'profile', serviceId: 'openai', profileId: 'openai-profile' },
    })).toMatchObject({
      kind: 'usage_limit',
      source: 'structured_provider_error',
    });
  });

  it('returns null for unclassifiable provider errors even with a concrete binding', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'session-1' },
      error: new Error('tool execution failed: file not found'),
      selection: { kind: 'profile', serviceId: 'openai', profileId: 'openai-profile' },
    })).toBeNull();
  });

  it('resolves serialized selection context with provider-owned precedence including Claude subscription', () => {
    expect(resolveOpenCodeRuntimeAuthSelection({
      selections: [
        { kind: 'profile', serviceId: 'anthropic', profileId: 'anthropic-profile' },
        { kind: 'group', serviceId: 'claude-subscription', groupId: 'team-claude', activeProfileId: 'claude-profile' },
      ],
      error: { name: 'FreeUsageLimitError', message: 'rate limited' },
    })).toEqual({
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: 'team-claude',
      activeProfileId: 'claude-profile',
    });
  });

  it('hot-applies brokered account swaps by bumping the daemon broker selection epoch', async () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.hotApply({
      target: { agentId: 'opencode' },
      selection: {
        serviceId: 'openai-codex',
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
        kind: 'group',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 12,
        record: { serviceId: 'openai-codex', profileId: 'profile-new' },
      },
    })).resolves.toEqual({
      applied: true,
      recovery: 'provider_owned_broker_selection',
      verification: {
        status: 'weakly_verified',
        proofStrength: 'weak',
        sharedAuthSurfaceId: 'opencode|connected|broker:1|openai-codex:acct-old:',
        source: 'broker_selection_indirection',
        reason: 'daemon_broker_selection_epoch_bumped',
      },
    });

    expect(getBrokerBridgeEffectiveSelectionForTest({
      selectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
      serviceId: 'openai-codex',
    })).toMatchObject({
      selectionEpoch: 1,
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 12,
      },
    });
  });
});

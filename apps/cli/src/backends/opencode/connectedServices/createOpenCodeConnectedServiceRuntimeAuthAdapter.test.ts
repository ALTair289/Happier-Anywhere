import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    resetBrokerBridgeEffectiveSelectionsForTests();
  });

  afterEach(() => {
    resetBrokerBridgeEffectiveSelectionsForTests();
  });

  it('preserves the managed server and claim after a broker-owned auth switch', async () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode' },
      selection: {
        serviceId: 'openai-codex',
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
        previousLaunchFingerprint: 'previous-fingerprint',
        previousOwnerToken: 'owner-token-1',
      },
    })).resolves.toMatchObject({
      recovered: true,
      recovery: 'provider_owned_broker_selection',
      detached: false,
      detachedReason: 'broker_request_time_selection_preserved',
    });
  });

  it('declines recovery without the broker selection identity used for request-time adoption', async () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode' },
      selection: { serviceId: 'openai-codex' },
    })).resolves.toEqual({
      recovered: false,
      recovery: 'restart_rematerialize',
      detached: false,
      detachedReason: 'broker_selection_identity_missing',
    });
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
        credentialRevision: 'rev-new',
        record: {
          kind: 'oauth',
          serviceId: 'openai-codex',
          profileId: 'profile-new',
          oauth: { accessToken: 'access-new', providerAccountId: 'acct-new' },
        },
      },
    })).resolves.toEqual({
      applied: true,
      recovery: 'provider_owned_broker_selection',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
        providerAccountId: 'acct-new',
        sharedAuthSurfaceId: 'opencode|connected|broker:1|openai-codex:acct-old:',
        source: 'broker_selection_indirection',
        reason: 'daemon_broker_selection_epoch_bumped',
        credentialRevision: 'rev-new',
        credentialFingerprint: 'sha256:0c7be3dc',
        generationApplication: {
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'profile-new',
          generation: 12,
          credentialRevision: 'rev-new',
          credentialFingerprint: 'sha256:0c7be3dc',
        },
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
        credentialRevision: 'rev-new',
        credentialFingerprint: 'sha256:0c7be3dc',
      },
    });
  });
});

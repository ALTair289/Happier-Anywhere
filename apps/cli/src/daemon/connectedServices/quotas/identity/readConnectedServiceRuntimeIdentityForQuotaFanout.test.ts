import { describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readConnectedServiceRuntimeIdentityForQuotaFanout } from './readConnectedServiceRuntimeIdentityForQuotaFanout';
import type { Credentials } from '@/persistence';

const credentials: Credentials = {
  token: 'happy-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
};

describe('readConnectedServiceRuntimeIdentityForQuotaFanout', () => {
  it('reads exact provider account identity through the bounded session runtime RPC', async () => {
    const callSessionRpc = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_exact',
        accountLabel: 'person@example.test',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: false,
        inProviderTurn: true,
        profileId: 'primary',
        groupId: 'team',
        generation: 4,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    }));
    const resolveSessionTransportContext = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_1',
      mode: 'plain' as const,
      ctx: {
        encryptionKey: new Uint8Array(32).fill(9),
        encryptionVariant: 'legacy' as const,
      },
    }));

    await expect(readConnectedServiceRuntimeIdentityForQuotaFanout({
      credentials,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      callSessionRpc,
      resolveSessionTransportContext,
      timeoutMs: 1_500,
    })).resolves.toEqual({
      status: 'verified',
      strategy: 'provider_account_id',
      providerAccountId: 'acct_exact',
      accountLabel: 'person@example.test',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      runtime: {
        safeToApply: false,
        inProviderTurn: true,
      },
    });

    expect(resolveSessionTransportContext).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
    });
    expect(callSessionRpc).toHaveBeenCalledWith({
      token: 'happy-token',
      sessionId: 'sess_1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(9),
        encryptionVariant: 'legacy',
      },
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY}`,
      timeoutMs: 1_500,
      request: {
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
        expected: {
          groupId: 'team',
          profileId: 'primary',
          generation: 4,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    });
  });

  it('accepts exact shared group auth-surface identity without a provider account id', async () => {
    const callSessionRpc = vi.fn(async () => ({
      ok: true,
      serviceId: 'claude-subscription',
      identity: {
        strategy: 'shared_group_auth_surface',
        proofStrength: 'exact',
        sharedAuthSurfaceId: 'claude-team',
        accountLabel: 'Team shared auth',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: true,
        inProviderTurn: false,
        profileId: 'stale-daemon-profile',
        groupId: 'claude-team',
        generation: 12,
      },
    }));
    const resolveSessionTransportContext = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_shared',
      mode: 'plain' as const,
      ctx: {
        encryptionKey: new Uint8Array(32).fill(9),
        encryptionVariant: 'legacy' as const,
      },
    }));

    await expect(readConnectedServiceRuntimeIdentityForQuotaFanout({
      credentials,
      sessionId: 'sess_shared',
      serviceId: 'claude-subscription',
      groupId: 'claude-team',
      profileId: 'old-profile',
      expectedGroupGeneration: 4,
      callSessionRpc,
      resolveSessionTransportContext,
    })).resolves.toEqual({
      status: 'verified',
      strategy: 'shared_group_auth_surface',
      sharedAuthSurfaceId: 'claude-team',
      accountLabel: 'Team shared auth',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
      profileId: 'stale-daemon-profile',
      groupId: 'claude-team',
      groupGeneration: 12,
      runtime: {
        safeToApply: true,
        inProviderTurn: false,
      },
    });
  });

  it('does not convert diagnostic or label-only runtime identity into destructive fanout proof', async () => {
    const callSessionRpc = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'diagnostic',
        accountLabel: 'person@example.test',
      },
    }));
    const resolveSessionTransportContext = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_1',
      mode: 'plain' as const,
      ctx: {
        encryptionKey: new Uint8Array(32).fill(9),
        encryptionVariant: 'legacy' as const,
      },
    }));

    await expect(readConnectedServiceRuntimeIdentityForQuotaFanout({
      credentials,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
      callSessionRpc,
      resolveSessionTransportContext,
    })).resolves.toEqual({
      status: 'inexact',
      reason: 'runtime_identity_probe_missing_exact_identity',
    });
  });

  it('rejects exact runtime identity responses for a different connected service', async () => {
    const callSessionRpc = vi.fn(async () => ({
      ok: true,
      serviceId: 'claude-subscription',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_exact',
      },
      runtime: {
        safeToApply: true,
        inProviderTurn: false,
      },
    }));
    const resolveSessionTransportContext = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_1',
      mode: 'plain' as const,
      ctx: {
        encryptionKey: new Uint8Array(32).fill(9),
        encryptionVariant: 'legacy' as const,
      },
    }));

    await expect(readConnectedServiceRuntimeIdentityForQuotaFanout({
      credentials,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
      callSessionRpc,
      resolveSessionTransportContext,
    })).resolves.toEqual({
      status: 'unavailable',
      reason: 'runtime_identity_probe_account_mismatch',
    });
  });
});

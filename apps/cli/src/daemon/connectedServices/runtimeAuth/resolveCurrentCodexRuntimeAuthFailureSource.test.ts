import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { computeConnectedServiceAccessTokenFingerprint } from '../refresh/credentialFreshness/tokenFingerprint';
import { resolveCurrentCodexRuntimeAuthFailureSource } from './resolveCurrentCodexRuntimeAuthFailureSource';

const currentRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const currentAccessToken = 'current-access';

function classification(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'usage_limit' as const,
    serviceId: 'openai-codex' as const,
    profileId: 'work',
    groupId: 'main',
    groupGeneration: 7,
    credentialRevision: null,
    sourceProviderAccountId: 'acct_work',
    failingAccessTokenFingerprint: computeConnectedServiceAccessTokenFingerprint(currentAccessToken),
    resetsAtMs: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error' as const,
    recoveryAction: { kind: 'quota_recovery_required' as const },
    ...overrides,
  };
}

function currentCredential() {
  return {
    credentialRevision: currentRevision,
    record: buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 10_000,
      oauth: {
        accessToken: currentAccessToken,
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_work',
        providerEmail: null,
      },
    }),
  };
}

function exactLiveIdentity() {
  return {
    status: 'verified' as const,
    strategy: 'provider_account_id' as const,
    providerAccountId: 'acct_work',
    proofStrength: 'exact' as const,
    source: 'runtime_identity_probe' as const,
    profileId: 'work',
    groupId: 'main',
    groupGeneration: 7,
  };
}

describe('resolveCurrentCodexRuntimeAuthFailureSource', () => {
  it('accepts a predecessor report without a revision only from matching live and canonical credential evidence', async () => {
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification(),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
    })).resolves.toEqual({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'work',
      generation: 7,
      credentialRevision: currentRevision,
    });
  });

  it.each([
    ['provider account', { sourceProviderAccountId: 'acct_other' }],
    ['token fingerprint', { failingAccessTokenFingerprint: 'sha256:deadbeef' }],
  ])('rejects predecessor evidence with a mismatched %s', async (_label, overrides) => {
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification(overrides),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
    })).resolves.toBeNull();
  });

  it('keeps current reports on opaque revision equality without requiring predecessor fingerprint evidence', async () => {
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({
        credentialRevision: currentRevision,
        sourceProviderAccountId: null,
        failingAccessTokenFingerprint: null,
      }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        credentialRevision: currentRevision,
      })),
      resolveCurrentCredential,
    })).resolves.toMatchObject({ credentialRevision: currentRevision });
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
  });

  it('does not reinterpret an exact live revision through newer server credential truth', async () => {
    const resolveCurrentCredential = vi.fn(async () => ({
      ...currentCredential(),
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }));
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({
        credentialRevision: currentRevision,
        sourceProviderAccountId: null,
        failingAccessTokenFingerprint: null,
      }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        credentialRevision: currentRevision,
      })),
      resolveCurrentCredential,
    })).resolves.toMatchObject({ credentialRevision: currentRevision });
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
  });

  it('does not copy a modern report revision into an exact live identity that omitted it', async () => {
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({
        credentialRevision: currentRevision,
        failingAccessTokenFingerprint: null,
      }),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential,
    })).rejects.toThrow('credential revision temporarily unavailable');
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
  });

  it('returns the exact current live tuple when a modern report names an older target', async () => {
    const liveRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({
        credentialRevision: currentRevision,
        sourceProviderAccountId: null,
        failingAccessTokenFingerprint: null,
      }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        profileId: 'replacement',
        groupGeneration: 7,
        credentialRevision: liveRevision,
      })),
      resolveCurrentCredential,
    })).resolves.toEqual({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'replacement',
      generation: 7,
      credentialRevision: liveRevision,
    });
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
  });

  it('adopts the exact current generation for a proven predecessor report', async () => {
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({ groupGeneration: 7 }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        groupGeneration: 8,
        credentialRevision: currentRevision,
      })),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
    })).resolves.toEqual({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'work',
      generation: 8,
      credentialRevision: currentRevision,
    });
  });

  it.each([
    ['runtime identity', {
      readRuntimeIdentity: vi.fn(async () => {
        throw new Error('runtime identity temporarily unavailable');
      }),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
    }],
    ['credential truth', {
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential: vi.fn(async () => {
        throw new Error('credential truth temporarily unavailable');
      }),
    }],
  ])('propagates a transient %s outage so the failure report can retry', async (_label, boundaries) => {
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification(),
      ...boundaries,
    })).rejects.toThrow('temporarily unavailable');
  });

  it('propagates a typed unavailable runtime identity so the failure report retains custody for retry', async () => {
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({
        credentialRevision: currentRevision,
        sourceProviderAccountId: null,
        failingAccessTokenFingerprint: null,
      }),
      readRuntimeIdentity: vi.fn(async () => ({
        status: 'unavailable' as const,
        reason: 'session RPC transport unavailable',
      })),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
    })).rejects.toThrow('session RPC transport unavailable');
  });

  it.each([
    ['an inexact response', { status: 'inexact' as const, reason: 'runtime target did not match' }],
    ['an unsupported null response', null],
  ])('treats %s as unavailable so the failure report retains custody', async (_label, probeResult) => {
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    await expect(resolveCurrentCodexRuntimeAuthFailureSource({
      classification: classification({
        credentialRevision: currentRevision,
        sourceProviderAccountId: null,
        failingAccessTokenFingerprint: null,
      }),
      readRuntimeIdentity: vi.fn(async () => probeResult),
      resolveCurrentCredential,
    })).rejects.toThrow('runtime identity temporarily unavailable');
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
  });
});

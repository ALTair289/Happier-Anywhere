import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeGenerationApplicationProofs } from './resolveRuntimeGenerationApplicationProofs';

describe('resolveRuntimeGenerationApplicationProofs', () => {
  it('returns only provider-verified proof for exact current group truth', async () => {
    const verifyGenerationApplication = vi.fn(async () => ({
      status: 'verified' as const,
      source: 'shared_surface',
      sharedAuthSurfaceId: 'team',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint: 'sha256:abcdef12',
    }));

    await expect(resolveRuntimeGenerationApplicationProofs({
      target: {
        sessionId: 'session-1',
        agentId: 'claude',
        connectedServiceSelectionsEnv: { CLAUDE_CONFIG_DIR: '/group-home' },
        activeBindings: [{
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'work',
          generation: 7,
          credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
          credentialFingerprint: 'sha256:abcdef12',
        }],
      },
      resolveLifecycleDescriptor: async () => ({ verifyGenerationApplication }),
      getCurrentGroup: async () => ({
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'work',
        generation: 7,
      }),
      isCurrent: () => true,
    })).resolves.toEqual([expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'work',
      generation: 7,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      proof: expect.objectContaining({ source: 'shared_surface', sharedAuthSurfaceId: 'team' }),
    })]);

    expect(verifyGenerationApplication).toHaveBeenCalledOnce();
  });

  it('does not ask the provider when runtime intent is not current group truth', async () => {
    const verifyGenerationApplication = vi.fn();
    await expect(resolveRuntimeGenerationApplicationProofs({
      target: {
        sessionId: 'session-1',
        agentId: 'claude',
        connectedServiceSelectionsEnv: {},
        activeBindings: [{
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'old',
          generation: 6,
        }],
      },
      resolveLifecycleDescriptor: async () => ({ verifyGenerationApplication }),
      getCurrentGroup: async () => ({
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'work',
        generation: 7,
      }),
      isCurrent: () => true,
    })).resolves.toEqual([]);
    expect(verifyGenerationApplication).not.toHaveBeenCalled();
  });

  it('does not return a proof after its reconciliation epoch is invalidated', async () => {
    let releaseVerification!: () => void;
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationStarted!: () => void;
    const verificationDidStart = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    let isCurrent = true;
    const resolving = resolveRuntimeGenerationApplicationProofs({
      target: {
        sessionId: 'session-1',
        agentId: 'claude',
        connectedServiceSelectionsEnv: {},
        activeBindings: [{
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'work',
          generation: 7,
        }],
      },
      resolveLifecycleDescriptor: async () => ({
        verifyGenerationApplication: async () => {
          verificationStarted();
          await verificationReleased;
          return {
            status: 'verified' as const,
            source: 'shared_surface',
            sharedAuthSurfaceId: 'team',
            credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
            credentialFingerprint: 'sha256:abcdef12',
          };
        },
      }),
      getCurrentGroup: async () => ({
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'work',
        generation: 7,
      }),
      isCurrent: () => isCurrent,
    });

    await verificationDidStart;
    isCurrent = false;
    releaseVerification();

    await expect(resolving).resolves.toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createRuntimeGenerationApplicationProofResolver } from './createRuntimeGenerationApplicationProofResolver';

describe('createRuntimeGenerationApplicationProofResolver', () => {
  it('wires catalog resolution, current group truth, and provider verification', async () => {
    const verifyGenerationApplication = vi.fn(async () => ({
      status: 'verified' as const,
      source: 'shared_surface',
      sharedAuthSurfaceId: 'team',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint: 'sha256:abcdef12',
    }));
    const resolveLifecycleDescriptor = vi.fn(async () => ({ verifyGenerationApplication }));
    const getCurrentGroup = vi.fn(async () => ({
      serviceId: 'claude-subscription' as const,
      groupId: 'team',
      activeProfileId: 'work',
      generation: 7,
    }));
    const resolveProofs = createRuntimeGenerationApplicationProofResolver({
      resolveLifecycleDescriptor,
      getCurrentGroup,
    });

    const proofs = await resolveProofs({
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
    }, { isCurrent: () => true });

    expect(resolveLifecycleDescriptor).toHaveBeenCalledWith('claude');
    expect(getCurrentGroup).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      groupId: 'team',
    });
    expect(verifyGenerationApplication).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'work',
      generation: 7,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint: 'sha256:abcdef12',
      environmentVariables: { CLAUDE_CONFIG_DIR: '/group-home' },
    });
    expect(proofs).toEqual([expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'work',
      generation: 7,
    })]);
  });

  it('fails closed before provider verification when current generation moved', async () => {
    const verifyGenerationApplication = vi.fn(async () => ({
      status: 'verified' as const,
      source: 'shared_surface',
      sharedAuthSurfaceId: 'team',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint: 'sha256:abcdef12',
    }));
    const resolveProofs = createRuntimeGenerationApplicationProofResolver({
      resolveLifecycleDescriptor: async () => ({ verifyGenerationApplication }),
      getCurrentGroup: async () => ({
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'work',
        generation: 8,
      }),
    });

    await expect(resolveProofs({
      sessionId: 'session-1',
      agentId: 'claude',
      connectedServiceSelectionsEnv: { CLAUDE_CONFIG_DIR: '/group-home' },
      activeBindings: [{
        serviceId: 'claude-subscription',
        groupId: 'team',
        profileId: 'work',
        generation: 7,
      }],
    }, { isCurrent: () => true })).resolves.toEqual([]);
    expect(verifyGenerationApplication).not.toHaveBeenCalled();
  });
});

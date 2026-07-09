import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConnectedServiceRuntimeRefreshTarget } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { computeClaudeCodeCredentialSafeTokenFingerprint, writeClaudeCodeCredentialsFile } from './nativeAuth/claudeCodeCredentialFile';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { hasStaleClaudeMaterializedHomeForBinding } from './materializedClaudeHomeFreshness';

async function seedProfileHome(params: Readonly<{
  activeServerDir: string;
  accessToken: string;
  now: number;
}>): Promise<void> {
  const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: params.activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: 'work',
    selection: {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: 'work',
      record: null as never,
    },
  });
  if (!claudeConfigDir) throw new Error('fixture');
  await writeClaudeCodeCredentialsFile({
    claudeConfigDir,
    payload: {
      claudeAiOauth: {
        accessToken: params.accessToken,
        expiresAt: params.now + 60 * 60_000,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    },
    preserveNewerExistingCredential: false,
  });
}

function buildProfileTarget(binding: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>): ConnectedServiceRuntimeRefreshTarget {
  return {
    agentId: 'claude',
    bindings: [binding],
    selectionsByServiceId: new Map([
      ['claude-subscription', {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'work',
      }],
    ]),
  } as unknown as ConnectedServiceRuntimeRefreshTarget;
}

describe('hasStaleClaudeMaterializedHomeForBinding', () => {
  it('treats a clock-valid materialized Claude home with a different access-token fingerprint as stale', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-home-freshness-server-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-home-freshness-home-'));
    const now = 1_000_000;
    const binding = { serviceId: 'claude-subscription' as const, profileId: 'work' };
    await seedProfileHome({ activeServerDir, accessToken: 'old-home-access', now });

    const stale = await hasStaleClaudeMaterializedHomeForBinding({
      binding,
      targets: [buildProfileTarget(binding)],
      activeServerDir,
      processEnv: { HOME: sourceHomeDir },
      now,
      refreshWindowMs: 60_000,
      resolveCanonicalGroupActiveProfileId: async () => null,
      resolveStoreAccessTokenFingerprintForProfile: async () =>
        computeClaudeCodeCredentialSafeTokenFingerprint('current-store-access'),
    });

    expect(stale).toBe(true);
  });

  it('treats a materialized Claude home holding exactly the owning store credential as fresh', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-home-freshness-server-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-home-freshness-home-'));
    const now = 1_000_000;
    const binding = { serviceId: 'claude-subscription' as const, profileId: 'work' };
    await seedProfileHome({ activeServerDir, accessToken: 'current-store-access', now });

    const stale = await hasStaleClaudeMaterializedHomeForBinding({
      binding,
      targets: [buildProfileTarget(binding)],
      activeServerDir,
      processEnv: { HOME: sourceHomeDir },
      now,
      refreshWindowMs: 60_000,
      resolveCanonicalGroupActiveProfileId: async () => null,
      resolveStoreAccessTokenFingerprintForProfile: async () =>
        computeClaudeCodeCredentialSafeTokenFingerprint('current-store-access'),
    });

    expect(stale).toBe(false);
  });

  it('fails closed (not stale) for a group home when canonical group state is unavailable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-home-freshness-server-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-home-freshness-home-'));
    const now = 1_000_000;
    const binding = { serviceId: 'claude-subscription' as const, profileId: 'memberB' };
    const target = {
      agentId: 'claude',
      bindings: [binding],
      selectionsByServiceId: new Map([
        ['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'pool',
          activeProfileId: 'memberB',
          fallbackProfileId: 'memberA',
          generation: 3,
        }],
      ]),
    } as unknown as ConnectedServiceRuntimeRefreshTarget;

    const stale = await hasStaleClaudeMaterializedHomeForBinding({
      binding,
      targets: [target],
      activeServerDir,
      processEnv: { HOME: sourceHomeDir },
      now,
      refreshWindowMs: 60_000,
      // Canonical state unreadable: the corridor must NOT trust the snapshot (activeProfileId
      // memberB) and must not report the shared home stale — no rewrite, no restart.
      resolveCanonicalGroupActiveProfileId: async () => null,
      resolveStoreAccessTokenFingerprintForProfile: async () =>
        computeClaudeCodeCredentialSafeTokenFingerprint('member-b-access'),
    });

    expect(stale).toBe(false);
  });
});

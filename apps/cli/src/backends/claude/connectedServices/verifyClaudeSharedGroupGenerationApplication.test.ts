import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeClaudeConnectedServiceHomeProvenance } from './claudeConnectedServiceHomeProvenance';
import {
  computeClaudeCodeCredentialFingerprint,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './nativeAuth/claudeCodeCredentialFile';
import { verifyClaudeSharedGroupGenerationApplication } from './verifyClaudeSharedGroupGenerationApplication';

describe('verifyClaudeSharedGroupGenerationApplication', () => {
  it('proves the provider-owned stable group surface only for its materialized group member', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-generation-proof-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'work-access-token',
          refreshToken: 'work-refresh-token',
          expiresAt: Date.now() + 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });
    const credentialFingerprint = computeClaudeCodeCredentialFingerprint(JSON.parse(
      await readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8'),
    ));
    await writeClaudeConnectedServiceHomeProvenance({
      claudeConfigDir,
      provenance: {
        v: 1,
        serviceId: 'claude-subscription',
        credentialProfileId: 'work',
        credentialCreatedAt: 1,
        credentialFingerprint,
        credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
        generation: 7,
        selection: {
          kind: 'group',
          groupId: 'team',
          activeProfileId: 'work',
          fallbackProfileId: 'backup',
        },
      },
    });

    await expect(verifyClaudeSharedGroupGenerationApplication({
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'work',
      generation: 7,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint,
      environmentVariables: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    })).resolves.toEqual({
      status: 'verified',
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: 'team',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint,
    });

    const exactInput = {
      serviceId: 'claude-subscription' as const,
      groupId: 'team',
      profileId: 'work',
      generation: 7,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS' as const,
      credentialFingerprint,
      environmentVariables: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    };
    for (const mismatched of [
      { ...exactInput, serviceId: 'openai-codex' as const },
      { ...exactInput, groupId: 'other-team' },
      { ...exactInput, profileId: 'other' },
      { ...exactInput, generation: 8 },
      { ...exactInput, credentialRevision: 'csr_8123456789ABCDEFGHJKMNPQRT' as const },
      { ...exactInput, credentialRevision: null },
      { ...exactInput, credentialFingerprint: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    ]) {
      await expect(verifyClaudeSharedGroupGenerationApplication(mismatched)).resolves.toEqual({ status: 'unavailable' });
    }
  });
});

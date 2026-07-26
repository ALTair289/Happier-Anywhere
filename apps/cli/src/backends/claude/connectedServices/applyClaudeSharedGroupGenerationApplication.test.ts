import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { applyClaudeSharedGroupGenerationApplication } from './applyClaudeSharedGroupGenerationApplication';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';

describe('applyClaudeSharedGroupGenerationApplication', () => {
  it('materializes and proves the exact committed generation on the shared Claude group surface', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-generation-'));
    const credentialRevision = 'csr_7123456789ABCDEFGHJKMNPQRS' as const;
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: Date.now() + 60_000,
      oauth: {
        accessToken: 'shared-generation-access-token',
        refreshToken: 'shared-generation-refresh-token',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: 'work@example.test',
      },
    });

    await expect(applyClaudeSharedGroupGenerationApplication({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'work',
      generation: 7,
      credentialRevision,
      record,
    })).resolves.toMatchObject({
      status: 'verified',
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: 'team',
      credentialRevision,
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'work',
      selection: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'work',
        fallbackProfileId: 'work',
        generation: 7,
        credentialRevision,
        record,
        policy: null,
      },
    });
    expect(claudeConfigDir).not.toBeNull();
    const provenance = JSON.parse(await readFile(
      join(claudeConfigDir!, '.happier-claude-connected-service-home.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      serviceId: 'claude-subscription',
      credentialProfileId: 'work',
      credentialRevision,
      generation: 7,
      selection: {
        kind: 'group',
        groupId: 'team',
        activeProfileId: 'work',
      },
    });
  });
});

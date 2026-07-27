import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { resolveCodexInitialConnectedServiceRuntimeIdentity } from './resolveCodexInitialConnectedServiceRuntimeIdentity';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('resolveCodexInitialConnectedServiceRuntimeIdentity', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('builds an exact runtime identity seed from the selected connected-service auth store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-identity-'));
    tempDirs.push(dir);
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    const accessToken = buildJwt({ email: 'team@example.test', exp: 4_102_444_800 });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'team@example.test', exp: 4_102_444_800 }),
          access_token: accessToken,
          account_id: 'acct_team_exact',
        },
      }),
      'utf8',
    );

    expect(resolveCodexInitialConnectedServiceRuntimeIdentity({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: codexHome,
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'team',
        fallbackProfileId: 'backup',
        generation: 9,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }]),
    })).toEqual({
      serviceId: 'openai-codex',
      activeAccountId: 'acct_team_exact',
      accountLabel: 'team@example.test',
      profileId: 'team',
      groupId: 'main',
      generation: 9,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      credentialFingerprint: computeConnectedServiceAccessTokenFingerprint(accessToken),
      source: 'spawn_selection',
    });
  });

  it('preserves child-env group generation when session metadata records the active group profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-identity-metadata-group-'));
    tempDirs.push(dir);
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    const accessToken = buildJwt({ email: 'team@example.test', exp: 4_102_444_800 });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'team@example.test', exp: 4_102_444_800 }),
          access_token: accessToken,
          account_id: 'acct_team_exact',
        },
      }),
      'utf8',
    );

    expect(resolveCodexInitialConnectedServiceRuntimeIdentity({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: codexHome,
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'team',
        fallbackProfileId: 'backup',
        generation: 9,
      }]),
    }, {
      getMetadataSnapshot: () => ({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'main',
              profileId: 'team',
            },
          },
        },
      }),
    })).toEqual({
      serviceId: 'openai-codex',
      activeAccountId: 'acct_team_exact',
      accountLabel: 'team@example.test',
      profileId: 'team',
      groupId: 'main',
      generation: 9,
      credentialRevision: null,
      credentialFingerprint: computeConnectedServiceAccessTokenFingerprint(accessToken),
      source: 'spawn_selection',
    });
  });

  it('does not stitch stale session metadata into the materialized auth identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-identity-stale-metadata-'));
    tempDirs.push(dir);
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    const accessToken = buildJwt({ email: 'materialized@example.test', exp: 4_102_444_800 });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'materialized@example.test', exp: 4_102_444_800 }),
          access_token: accessToken,
          account_id: 'acct_materialized',
        },
      }),
      'utf8',
    );

    expect(resolveCodexInitialConnectedServiceRuntimeIdentity({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: codexHome,
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'materialized',
        fallbackProfileId: 'backup',
        generation: 9,
      }]),
    }, {
      getMetadataSnapshot: () => ({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'main',
              profileId: 'newer-metadata-only',
            },
          },
        },
      }),
    })).toEqual({
      serviceId: 'openai-codex',
      activeAccountId: 'acct_materialized',
      accountLabel: 'materialized@example.test',
      profileId: 'materialized',
      groupId: 'main',
      generation: 9,
      credentialRevision: null,
      credentialFingerprint: computeConnectedServiceAccessTokenFingerprint(accessToken),
      source: 'spawn_selection',
    });
  });

  it('does not seed identity when exact provider account id is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-identity-missing-'));
    tempDirs.push(dir);
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'team@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ email: 'team@example.test', exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );

    expect(resolveCodexInitialConnectedServiceRuntimeIdentity({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: codexHome,
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'team',
        fallbackProfileId: 'backup',
        generation: 9,
      }]),
    })).toBeNull();
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildConnectedServiceCredentialRecord, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  fakeClaudeFixturePath,
  waitForFakeClaudeInvocation,
  waitForFakeClaudeNativeAuthContract,
} from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const claudeSubscriptionServiceId = 'claude-subscription';
const claudeCodeScopes = 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Expected string ${key}`);
  return value;
}

function isRealClaudeSessionArgv(argv: readonly string[] | undefined): boolean {
  if (!argv) return false;
  if (argv.includes('--version') || argv.includes('-v')) return false;
  return argv.includes('--settings') && argv.includes('--plugin-dir');
}

function isRealClaudeResumeSessionArgv(argv: readonly string[] | undefined): boolean {
  return argv !== undefined && isRealClaudeSessionArgv(argv) && argv.includes('--resume');
}

async function createClaudeSubscriptionProfile(params: Readonly<{
  serverBaseUrl: string;
  token: string;
  secret: Uint8Array;
  profileId: string;
  accessToken: string;
  refreshToken: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId: claudeSubscriptionServiceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: now + 60 * 60_000,
    oauth: {
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      idToken: null,
      scope: claudeCodeScopes,
      tokenType: 'Bearer',
      providerAccountId: `acct-claude-${params.profileId}`,
      providerEmail: params.providerEmail,
    },
  });

  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret: params.secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const putCredential = await fetchJson<{ success?: boolean }>(
    `${params.serverBaseUrl}/v2/connect/${claudeSubscriptionServiceId}/profiles/${params.profileId}/credential`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: params.providerEmail,
          providerAccountId: `acct-claude-${params.profileId}`,
          expiresAt: record.expiresAt,
        },
      }),
      timeoutMs: 20_000,
    },
  );
  expect(putCredential.status).toBe(200);
  expect(putCredential.data?.success).toBe(true);
}

async function createClaudeSubscriptionAuthGroup(params: Readonly<{
  serverBaseUrl: string;
  token: string;
  groupId: string;
  activeProfileId: string;
  memberProfileIds: readonly string[];
}>): Promise<UnknownRecord> {
  const response = await fetchJson<{ group?: unknown }>(
    `${params.serverBaseUrl}/v3/connect/${claudeSubscriptionServiceId}/groups`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        groupId: params.groupId,
        members: params.memberProfileIds.map((profileId, index) => ({
          profileId,
          priority: (index + 1) * 10,
        })),
        activeProfileId: params.activeProfileId,
        policy: {
          autoSwitch: true,
          preTurnProbeMode: 'never',
          recoveryMode: 'switch_or_wait',
        },
      }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function fetchClaudeSubscriptionAuthGroup(params: Readonly<{
  serverBaseUrl: string;
  token: string;
  groupId: string;
}>): Promise<UnknownRecord> {
  const response = await fetchJson<{ group?: unknown }>(
    `${params.serverBaseUrl}/v3/connect/${claudeSubscriptionServiceId}/groups/${params.groupId}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function readClaudeNativeAccessToken(credentialsPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(credentialsPath, 'utf8')) as unknown;
  const credential = asRecord(asRecord(parsed)?.claudeAiOauth);
  if (!credential) throw new Error('Expected claudeAiOauth credentials');
  return readString(credential, 'accessToken');
}

describe('core e2e: Claude Unified connected services native auth', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    daemon = null;
    server = null;
  });

  it('launches Claude Unified with isolated CLAUDE_CONFIG_DIR credentials instead of raw OAuth env tokens', async () => {
    const testDir = run.testDir('connected-services-claude-unified-native-auth');
    const startedAt = new Date().toISOString();

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: serverBaseUrl,
      token: auth.token,
      secret,
    });

    await upsertEncryptedAccountSettingsV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      secret,
      settings: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSourcesV2: ['user', 'project', 'local'],
      },
    });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'connected-services-claude-unified-native-auth',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
      },
    });

    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'e2e-claude-access-token',
        refreshToken: 'e2e-claude-refresh-token',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
        tokenType: 'Bearer',
        providerAccountId: 'acct-claude-work',
        providerEmail: 'claude-work@example.test',
      },
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const putCredential = await fetchJson<{ success?: boolean }>(
      `${serverBaseUrl}/v2/connect/claude-subscription/profiles/work/credential`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: 'claude-work@example.test',
            providerAccountId: 'acct-claude-work',
            expiresAt: record.expiresAt,
          },
        }),
        timeoutMs: 20_000,
      },
    );
    expect(putCredential.status).toBe(200);
    expect(putCredential.data?.success).toBe(true);

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
    };

    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    await waitFor(async () => {
      const res = await daemonControlPostJson({
        port: daemon!.state.httpPort,
        path: '/list',
        body: {},
        controlToken: daemon!.state.controlToken,
      });
      return res.status === 200;
    }, { timeoutMs: 20_000 });

    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        agent: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        initialPrompt: 'E2E_CLAUDE_UNIFIED_NATIVE_AUTH',
        environmentVariables: {
          CI: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', profileId: 'work' },
          },
        },
      },
      timeoutMs: 60_000,
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    expect(typeof spawnRes.data?.sessionId).toBe('string');

    const invocation = await waitForFakeClaudeInvocation(
      fakeLogPath,
      (event) => event.mode === 'local' && isRealClaudeSessionArgv(event.argv),
      { timeoutMs: 60_000, pollMs: 150 },
    );
    expect(invocation.argv.length).toBeGreaterThan(0);

    const nativeAuthContract = await waitForFakeClaudeNativeAuthContract(
      fakeLogPath,
      (event) => event.invocationId === invocation.invocationId && event.mode === 'local' && isRealClaudeSessionArgv(event.argv) && event.ok,
      {
        timeoutMs: 30_000,
        pollMs: 150,
      },
    );
    expect(nativeAuthContract).toMatchObject({
      ok: true,
      hasClaudeConfigDirEnv: true,
      hasCredentialFile: true,
      hasClaudeAiOauth: true,
      hasAccessToken: true,
      hasRefreshToken: true,
      hasOauthEnvToken: false,
      hasSetupEnvToken: false,
    });
    expect(nativeAuthContract.missingScopes).toEqual([]);

    await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/stop-session',
      controlToken: daemon.state.controlToken,
      body: { sessionId: spawnRes.data?.sessionId },
      timeoutMs: 30_000,
    }).catch(() => {});
  }, 240_000);

  it('runtime-auth usage-limit recovery switches a Claude group and restarts Unified with the next native credential file', async () => {
    const testDir = run.testDir(`connected-services-claude-unified-runtime-switch-${randomUUID()}`);
    const startedAt = new Date().toISOString();

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: serverBaseUrl,
      token: auth.token,
      secret,
    });

    await upsertEncryptedAccountSettingsV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      secret,
      settings: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSourcesV2: ['user', 'project', 'local'],
      },
    });

    const groupId = `claude-rt-${randomUUID().slice(0, 8)}`;
    await createClaudeSubscriptionProfile({
      serverBaseUrl,
      token: auth.token,
      secret,
      profileId: 'primary',
      accessToken: 'e2e-claude-primary-access-token',
      refreshToken: 'e2e-claude-primary-refresh-token',
      providerEmail: 'claude-primary@example.test',
    });
    await createClaudeSubscriptionProfile({
      serverBaseUrl,
      token: auth.token,
      secret,
      profileId: 'backup',
      accessToken: 'e2e-claude-backup-access-token',
      refreshToken: 'e2e-claude-backup-refresh-token',
      providerEmail: 'claude-backup@example.test',
    });
    const createdGroup = await createClaudeSubscriptionAuthGroup({
      serverBaseUrl,
      token: auth.token,
      groupId,
      activeProfileId: 'primary',
      memberProfileIds: ['primary', 'backup'],
    });
    expect(createdGroup).toMatchObject({ activeProfileId: 'primary' });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'connected-services-claude-unified-runtime-switch',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
      },
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude-runtime-switch.jsonl'));
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
      HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    };

    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    await waitFor(async () => {
      const res = await daemonControlPostJson({
        port: daemon!.state.httpPort,
        path: '/list',
        body: {},
        controlToken: daemon!.state.controlToken,
      });
      return res.status === 200;
    }, { timeoutMs: 20_000 });

    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        agent: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        initialPrompt: 'E2E_CLAUDE_UNIFIED_NATIVE_AUTH_GROUP_PRIMARY',
        environmentVariables: {
          CI: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            [claudeSubscriptionServiceId]: {
              source: 'connected',
              selection: 'group',
              groupId,
              profileId: 'primary',
            },
          },
        },
      },
      timeoutMs: 60_000,
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    const sessionId = spawnRes.data?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Expected spawned session id');

    const firstContract = await waitForFakeClaudeNativeAuthContract(
      fakeLogPath,
      (event) => event.mode === 'local' && isRealClaudeSessionArgv(event.argv) && event.ok,
      {
        timeoutMs: 30_000,
        pollMs: 150,
      },
    );
    expect(firstContract).toMatchObject({
      ok: true,
      hasClaudeConfigDirEnv: true,
      hasCredentialFile: true,
      hasClaudeAiOauth: true,
      hasAccessToken: true,
      hasRefreshToken: true,
      hasOauthEnvToken: false,
      hasSetupEnvToken: false,
    });
    expect(await readClaudeNativeAccessToken(firstContract.credentialsPath)).toBe('e2e-claude-primary-access-token');

    const recovery = await daemonControlPostJson<{
      ok?: boolean;
      result?: unknown;
    }>({
      port: daemon.state.httpPort,
      path: '/connected-service-runtime-auth/failure',
      controlToken: daemon.state.controlToken,
      body: {
        sessionId,
        switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit',
          limitCategory: 'quota',
          serviceId: claudeSubscriptionServiceId,
          profileId: 'primary',
          groupId,
          resetsAtMs: Date.now() + 60_000,
          retryAfterMs: 60_000,
          quotaScope: 'account',
          providerLimitId: 'claude-unified-primary',
          planType: 'pro',
          rateLimits: null,
          source: 'structured_provider_error',
        },
      },
      timeoutMs: 120_000,
    });

    expect(recovery.status).toBe(200);
    expect(recovery.data?.ok).toBe(true);
    expect(recovery.data?.result).toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
      },
    });

    await waitFor(async () => {
      const group = await fetchClaudeSubscriptionAuthGroup({ serverBaseUrl, token: auth.token, groupId });
      return readString(group, 'activeProfileId') === 'backup';
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      context: 'Claude Unified runtime-auth recovery switches the connected-service group to backup',
    });

    const secondContract = await waitForFakeClaudeNativeAuthContract(
      fakeLogPath,
      (event) => (
        event.invocationId !== firstContract.invocationId
        && event.mode === 'local'
        && isRealClaudeResumeSessionArgv(event.argv)
        && event.ok
      ),
      { timeoutMs: 90_000, pollMs: 150 },
    );
    expect(secondContract).toMatchObject({
      ok: true,
      hasClaudeConfigDirEnv: true,
      hasCredentialFile: true,
      hasClaudeAiOauth: true,
      hasAccessToken: true,
      hasRefreshToken: true,
      hasOauthEnvToken: false,
      hasSetupEnvToken: false,
    });
    expect(secondContract.missingScopes).toEqual([]);
    expect(await readClaudeNativeAccessToken(secondContract.credentialsPath)).toBe('e2e-claude-backup-access-token');

    await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/stop-session',
      controlToken: daemon.state.controlToken,
      body: { sessionId },
      timeoutMs: 30_000,
    }).catch(() => {});
  }, 360_000);
});

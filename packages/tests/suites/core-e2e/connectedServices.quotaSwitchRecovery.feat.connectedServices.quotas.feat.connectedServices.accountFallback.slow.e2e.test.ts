import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  accountSettingsParse,
  buildConnectedServiceCredentialRecord,
  getNotificationsSettingsV1FromAccountSettings,
  resolveNotificationChannelsV1FromAccountSettings,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession, fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;
type SessionTurnMutationResponse = Readonly<{ success?: unknown; reason?: unknown }>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected numeric ${key}`);
  return value;
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected string ${key}`);
  return value;
}

async function readAccountSettings(params: Readonly<{ baseUrl: string; token: string }>): Promise<UnknownRecord> {
  const response = await fetchJson<unknown>(`${params.baseUrl}/v1/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (response.status !== 200) throw new Error(`Expected account settings 200, received ${response.status}`);
  const record = asRecord(response.data);
  if (!record) throw new Error('Expected account settings object response');
  return record;
}

async function postSessionTurnMutation(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  mutation: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const response = await fetchJson<SessionTurnMutationResponse>(`${params.baseUrl}/v1/sessions/${params.sessionId}/turns/mutations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.mutation),
    timeoutMs: 20_000,
  });
  if (response.status !== 200 || response.data?.success !== true) {
    throw new Error(`Failed to post session turn mutation (status=${response.status}, reason=${String(response.data?.reason)})`);
  }
}

function createReusableKeyChallengeAuth() {
  const kp = tweetnacl.sign.keyPair();
  const publicKey = Uint8Array.from(kp.publicKey);
  const secretKey = Uint8Array.from(kp.secretKey);

  return async (baseUrl: string): Promise<{ token: string; publicKeyBase64: string }> => {
    const challenge = Uint8Array.from(randomBytes(32));
    const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, secretKey));
    const body = {
      publicKey: privacyKit.encodeBase64(publicKey),
      challenge: privacyKit.encodeBase64(challenge),
      signature: privacyKit.encodeBase64(signature),
    };

    const response = await fetchJson<{ token?: string }>(`${baseUrl}/v1/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    });
    if (response.status !== 200 || typeof response.data?.token !== 'string' || response.data.token.length === 0) {
      throw new Error(`Failed to mint reusable key-challenge auth token (status=${response.status})`);
    }
    return { token: response.data.token, publicKeyBase64: body.publicKey };
  };
}

async function createConnectedServiceProfile(params: Readonly<{
  baseUrl: string;
  token: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const secret = Uint8Array.from(randomBytes(32));
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: now + 60 * 60_000,
    oauth: {
      accessToken: `access-${params.profileId}`,
      refreshToken: `refresh-${params.profileId}`,
      idToken: `id-${params.profileId}`,
      scope: null,
      tokenType: null,
      providerAccountId: `acct-${params.profileId}`,
      providerEmail: params.providerEmail,
    },
  });
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const response = await fetchJson<{ success?: boolean }>(
    `${params.baseUrl}/v2/connect/${params.serviceId}/profiles/${params.profileId}/credential`,
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
          providerAccountId: `acct-${params.profileId}`,
          expiresAt: record.expiresAt,
        },
      }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  expect(response.data?.success).toBe(true);
}

async function createConnectedServiceAuthGroup(params: Readonly<{
  baseUrl: string;
  token: string;
  serviceId: string;
  groupId: string;
  activeProfileId: string;
  memberProfileIds: readonly string[];
}>): Promise<UnknownRecord> {
  const response = await fetchJson<{ group?: unknown }>(`${params.baseUrl}/v3/connect/${params.serviceId}/groups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      groupId: params.groupId,
      members: params.memberProfileIds.map((profileId, index) => ({ profileId, priority: (index + 1) * 10 })),
      activeProfileId: params.activeProfileId,
      policy: {
        autoSwitch: true,
        recoveryMode: 'switch_or_wait',
      },
    }),
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function patchConnectedServiceAuthGroupRuntimeState(params: Readonly<{
  baseUrl: string;
  token: string;
  serviceId: string;
  groupId: string;
  expectedGeneration: number;
  memberProfileId: string;
  quotaExhaustedUntilMs: number | null;
}>): Promise<UnknownRecord> {
  const response = await fetchJson<{ group?: unknown }>(
    `${params.baseUrl}/v3/connect/${params.serviceId}/groups/${params.groupId}/runtime-state`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedGeneration: params.expectedGeneration,
        state: {
          status: params.quotaExhaustedUntilMs === null ? 'ready' : 'exhausted',
          ...(params.quotaExhaustedUntilMs === null ? {} : { lastSwitchReason: 'usage_limit' }),
        },
        memberStates: [
          {
            profileId: params.memberProfileId,
            state: params.quotaExhaustedUntilMs === null
              ? { quotaExhaustedUntilMs: null, lastObservedAtMs: Date.now() }
              : {
                  quotaExhaustedUntilMs: params.quotaExhaustedUntilMs,
                  lastFailureKind: 'usage_limit',
                  lastFailureCode: 'usage_limit_reached',
                  lastObservedAtMs: Date.now(),
                },
          },
        ],
      }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group runtime-state response');
  return group;
}

async function fetchConnectedServiceAuthGroup(params: Readonly<{
  baseUrl: string;
  token: string;
  serviceId: string;
  groupId: string;
}>): Promise<UnknownRecord> {
  const response = await fetchJson<{ group?: unknown }>(
    `${params.baseUrl}/v3/connect/${params.serviceId}/groups/${params.groupId}`,
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

describe('core e2e: connected-service quota switch and recovery contracts', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('persists connected-service usage-limit context through canonical session turn mutations', async () => {
    const testDir = run.testDir(`connected-service-usage-limit-runtime-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
        HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const occurredAt = Date.now();
    const resetAtMs = occurredAt + 60_000;
    const turnId = `turn-${randomUUID()}`;
    const issue: SessionRuntimeIssueV1 = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_usage_limit',
      source: 'usage_limit',
      provider: 'codex',
      occurredAt,
      sanitizedPreview: 'Provider usage limit reached.',
      usageLimit: {
        v: 1,
        resetAtMs,
        retryAfterMs: 60_000,
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'primary',
        planType: 'pro',
        utilization: 100,
        action: { kind: 'settings' },
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main-group',
          groupExhausted: true,
        },
      },
    };

    await postSessionTurnMutation({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      mutation: {
        v: 1,
        action: 'begin',
        sessionId,
        turnId,
        mutationId: `mutation-${randomUUID()}`,
        observedAt: occurredAt,
        provider: 'codex',
      },
    });
    await postSessionTurnMutation({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      mutation: {
        v: 1,
        action: 'fail',
        sessionId,
        turnId,
        mutationId: `mutation-${randomUUID()}`,
        observedAt: occurredAt + 1,
        provider: 'codex',
        issue,
      },
    });

    await waitFor(async () => {
      const updated = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      return updated.latestTurnStatus === 'failed'
        && updated.lastRuntimeIssue?.source === 'usage_limit'
        && updated.lastRuntimeIssue.usageLimit?.connectedService?.groupId === 'main-group';
    }, {
      timeoutMs: 20_000,
      context: 'canonical session turn usage-limit issue includes connected-service group context',
    });

    const updated = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    expect(updated.lastRuntimeIssue).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        recoverability: 'switch_account',
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main-group',
          groupExhausted: true,
        },
      },
    });
  }, 180_000);

  it('roundtrips connected-service notification topics through account settings', async () => {
    const testDir = run.testDir(`connected-service-notification-settings-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const before = await readAccountSettings({ baseUrl: server.baseUrl, token: auth.token });
    const settingsVersion = readNumber(before, 'settingsVersion');

    const nextSettings = {
      schemaVersion: 2,
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        permissionRequest: true,
        userActionRequest: true,
        connectedServiceAccountSwitch: true,
        connectedServiceQuotaBlocked: false,
        connectedServiceQuotaRecovered: true,
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
          kind: 'expo_push',
          enabled: true,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    };

    const write = await fetchJson<unknown>(`${server.baseUrl}/v1/account/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        settings: JSON.stringify(nextSettings),
        expectedVersion: settingsVersion,
      }),
      timeoutMs: 20_000,
    });
    expect(write.status).toBe(200);

    const after = await readAccountSettings({ baseUrl: server.baseUrl, token: auth.token });
    const parsed = accountSettingsParse(JSON.parse(readString(after, 'settings')) as unknown);
    const notifications = getNotificationsSettingsV1FromAccountSettings(parsed);
    expect(notifications).toMatchObject({
      connectedServiceAccountSwitch: true,
      connectedServiceQuotaBlocked: false,
      connectedServiceQuotaRecovered: true,
    });
    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      expect.objectContaining({
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        topics: expect.objectContaining({
          connectedServiceAccountSwitch: true,
          connectedServiceQuotaBlocked: false,
          connectedServiceQuotaRecovered: true,
        }),
      }),
    ]);
  }, 180_000);

  it('persists auth-group runtime exhaustion across restart and blocks selection until reset', async () => {
    const testDir = run.testDir(`connected-service-auth-group-runtime-state-${randomUUID()}`);
    const restartEnv = {
      HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
    };
    const reauth = createReusableKeyChallengeAuth();
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: restartEnv,
    });
    const auth = await reauth(server.baseUrl);
    const serviceId = 'openai-codex';
    const groupId = 'codex-main';

    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      serviceId,
      profileId: 'primary',
      providerEmail: 'primary@example.test',
    });
    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      serviceId,
      profileId: 'backup',
      providerEmail: 'backup@example.test',
    });
    const created = await createConnectedServiceAuthGroup({
      baseUrl: server.baseUrl,
      token: auth.token,
      serviceId,
      groupId,
      activeProfileId: 'backup',
      memberProfileIds: ['primary', 'backup'],
    });
    expect(created).toMatchObject({ activeProfileId: 'backup', generation: 0 });

    const resetAtMs = Date.now() + 60_000;
    await patchConnectedServiceAuthGroupRuntimeState({
      baseUrl: server.baseUrl,
      token: auth.token,
      serviceId,
      groupId,
      expectedGeneration: 0,
      memberProfileId: 'primary',
      quotaExhaustedUntilMs: resetAtMs,
    });

    await server.stop();
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: restartEnv,
      preserveExistingDataDir: true,
    });
    const restartedAuth = await reauth(server.baseUrl);

    const restarted = await fetchConnectedServiceAuthGroup({
      baseUrl: server.baseUrl,
      token: restartedAuth.token,
      serviceId,
      groupId,
    });
    expect(restarted).toMatchObject({
      activeProfileId: 'backup',
      state: { status: 'exhausted', lastSwitchReason: 'usage_limit' },
      members: expect.arrayContaining([
        expect.objectContaining({
          profileId: 'primary',
          state: expect.objectContaining({ quotaExhaustedUntilMs: resetAtMs }),
        }),
      ]),
    });

    const blocked = await fetchJson<unknown>(`${server.baseUrl}/v3/connect/${serviceId}/groups/${groupId}/active-profile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${restartedAuth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'primary', expectedGeneration: 0 }),
      timeoutMs: 20_000,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.data).toEqual({ error: 'connect_group_profile_runtime_cooldown', resetAtMs });

    await patchConnectedServiceAuthGroupRuntimeState({
      baseUrl: server.baseUrl,
      token: restartedAuth.token,
      serviceId,
      groupId,
      expectedGeneration: 0,
      memberProfileId: 'primary',
      quotaExhaustedUntilMs: null,
    });
    const switched = await fetchJson<{ group?: unknown }>(
      `${server.baseUrl}/v3/connect/${serviceId}/groups/${groupId}/active-profile`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${restartedAuth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId: 'primary', expectedGeneration: 0 }),
        timeoutMs: 20_000,
      },
    );
    expect(switched.status).toBe(200);
    expect(switched.data?.group).toMatchObject({ activeProfileId: 'primary', generation: 1 });
  }, 240_000);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';

type SendToAllDevicesAsync = (title: string, body: string, data: Record<string, unknown>) => Promise<void>;

function buildActiveSettings() {
  return accountSettingsParse({
    notificationChannelsV1: [{
      v: 1,
      id: 'expo',
      kind: 'expo_push',
      enabled: true,
      topics: {
        ready: false,
        permissionRequest: false,
        userActionRequest: false,
        connectedServiceAccountSwitch: true,
        connectedServiceQuotaBlocked: false,
        connectedServiceQuotaRecovered: false,
      },
      readyIncludeMessageText: false,
    }],
  });
}

function stubSessionFetch(): void {
  vi.spyOn(axios, 'get').mockResolvedValue({
    status: 200,
    data: {
      session: {
        id: 'sess-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        encryptionMode: 'plain',
        metadata: '{}',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        dataEncryptionKey: null,
      },
    },
  });
}

const listProfiles = vi.fn(async () => ({
  serviceId: 'openai-codex' as const,
  profiles: [
    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
  ],
}));

async function buildRuntime(sendToAllDevicesAsync: SendToAllDevicesAsync) {
  const { surfaceConnectedServiceAccountSwitchOutcome } = await import('./surfaceConnectedServiceAccountSwitchOutcome');
  return (input: Readonly<{ sessionId: string; event: unknown }>) =>
    surfaceConnectedServiceAccountSwitchOutcome(
      {
        credentials: {
          token: 'token-1',
          encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
        },
        runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
        listConnectedServiceProfiles: listProfiles,
        expoPushSender: { sendToAllDevicesAsync },
        getActiveAccountSettingsSnapshot: () => ({ settings: buildActiveSettings(), settingsSecretsReadKeys: [] }),
        resolveSessionNotificationTitle: () => 'Recovery swap',
        nowMs: () => 2_000,
        dedupeWindowMs: 0,
        logDebug: () => {},
      },
      input,
    );
}

describe('surfaceConnectedServiceAccountSwitchOutcome', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
    listProfiles.mockClear();
  });

  it('emits BOTH the transcript switch event and the user notification for a recovery (usage_limit) swap', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    stubSessionFetch();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { didWrite: true, message: { id: 'msg-1', seq: 2, localId: 'local-1', createdAt: 2 } },
    });
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    const surface = await buildRuntime(sendToAllDevicesAsync);
    surface({
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
        mode: 'restart_resume',
      },
    });
    // fire-and-forget internals settle on the microtask/macrotask queue.
    await vi.waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/sessions\/sess-1\/messages$/),
        expect.objectContaining({
          localId: expect.stringMatching(/^connected-service-account-switch:openai-codex:main:/),
        }),
        expect.anything(),
      );
      expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    });
    const call = sendToAllDevicesAsync.mock.calls[0];
    if (!call) throw new Error('expected notification');
    const [title, body, data] = call;
    expect(title).toBe('Recovery swap');
    expect(body).toContain('provider reported');
    expect(data).toMatchObject({ reason: 'usage_limit', serviceDisplayName: 'OpenAI' });
  });

  it('commits the transcript event but suppresses the notification for a manual swap', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    stubSessionFetch();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { didWrite: true, message: { id: 'msg-2', seq: 2, localId: 'local-2', createdAt: 2 } },
    });
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    const surface = await buildRuntime(sendToAllDevicesAsync);
    surface({
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'manual',
        mode: 'restart_resume',
      },
    });
    await vi.waitFor(() => {
      expect(postSpy).toHaveBeenCalledTimes(1);
    });
    // Give any (incorrect) notification dispatch a chance to run before asserting absence.
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('emits BOTH the transcript switch event and the preventive notification for a preemptive (soft_threshold) swap', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    stubSessionFetch();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { didWrite: true, message: { id: 'msg-3', seq: 2, localId: 'local-3', createdAt: 2 } },
    });
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    const surface = await buildRuntime(sendToAllDevicesAsync);
    surface({
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        mode: 'hot_apply',
      },
    });
    await vi.waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/sessions\/sess-1\/messages$/),
        expect.objectContaining({
          localId: expect.stringMatching(/^connected-service-account-switch:openai-codex:main:/),
        }),
        expect.anything(),
      );
      expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    });
    const call = sendToAllDevicesAsync.mock.calls[0];
    if (!call) throw new Error('expected notification');
    const [, body, data] = call;
    expect(body).toContain('preventively');
    expect(data).toMatchObject({ reason: 'soft_threshold', serviceDisplayName: 'OpenAI' });
  });

  it('stays fully silent for an internal same-provider fanout swap: no transcript event, no notification', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    stubSessionFetch();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { didWrite: true, message: { id: 'msg-4', seq: 2, localId: 'local-4', createdAt: 2 } },
    });
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    const surface = await buildRuntime(sendToAllDevicesAsync);
    surface({
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'same_provider_account_exhausted',
        mode: 'hot_apply',
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(postSpy).not.toHaveBeenCalled();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });
});

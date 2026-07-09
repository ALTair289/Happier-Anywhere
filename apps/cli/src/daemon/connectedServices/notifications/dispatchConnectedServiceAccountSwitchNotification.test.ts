import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from './dispatchConnectedServiceAccountSwitchNotification';

type SendToAllDevicesAsync = (title: string, body: string, data: Record<string, unknown>) => Promise<void>;
type PushNotificationCall = Parameters<SendToAllDevicesAsync>;
type FetchNotificationCall = (input: unknown, init?: { body?: unknown }) => Promise<{ ok: boolean; status: number }>;
type PushNotificationSpy = Readonly<{
  mock: Readonly<{
    calls: PushNotificationCall[];
  }>;
}>;

function readOnlyPushNotificationCall(sendToAllDevicesAsync: PushNotificationSpy): PushNotificationCall {
  expect(sendToAllDevicesAsync.mock.calls).toHaveLength(1);
  const call = sendToAllDevicesAsync.mock.calls[0];
  if (!call) throw new Error('Expected one push notification call');
  return call;
}

describe('dispatchConnectedServiceAccountSwitchNotificationAsync', () => {
  it('uses provider and account display names with reason-aware remaining quota copy for automatic switches', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async (
      _title: string,
      _body: string,
      _data: Record<string, unknown>,
    ) => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          unit: 'unknown',
          remainingPct: 0,
          utilizationPct: 100,
          used: null,
          limit: null,
          resetAtMs: null,
          resetsAt: null,
          status: 'ok',
          confidence: 'exact',
          details: { limitCategory: 'usage_limit' },
        }],
      },
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          unit: 'unknown',
          remainingPct: 80,
          utilizationPct: 20,
          used: null,
          limit: null,
          resetAtMs: null,
          resetsAt: null,
          status: 'ok',
          confidence: 'exact',
          details: { limitCategory: 'usage_limit' },
        }],
      },
    });

    await dispatchConnectedServiceAccountSwitchNotificationAsync({
      settings: accountSettingsParse({
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
      }),
      expoPushSender: { sendToAllDevicesAsync },
      settingsSecretsReadKeys: [],
      runtimeQuotaSnapshots,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          {
            profileId: 'primary',
            status: 'connected' as const,
            providerEmail: 'main@example.test',
            providerAccountId: 'opaque-main-account-id',
          },
          {
            profileId: 'backup',
            status: 'connected' as const,
            displayName: 'Backup profile',
            providerEmail: 'backup@example.test',
            providerAccountId: 'opaque-backup-account-id',
          },
        ],
      })),
      source: {
        sessionId: 'session-1',
        sessionTitle: 'Fix checkout flow',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
        limitCategory: 'quota',
      },
      nowMs: () => 2_000,
      dedupeWindowMs: 0,
    });

    const [title, body, data] = readOnlyPushNotificationCall(sendToAllDevicesAsync);
    expect(title).toBe('Fix checkout flow');
    expect(body).toContain('OpenAI');
    expect(body).toContain('provider reported');
    expect(body).toContain('main@example.test');
    expect(body).toContain('Backup profile');
    expect(body).toContain('Previous account: Weekly 0% remaining');
    expect(body).toContain('New account: Weekly 80% remaining');
    expect(body).not.toContain('openai-codex');
    expect(body).not.toContain('opaque-backup-account-id');
    expect(data).toMatchObject({
      sessionId: 'session-1',
      serviceDisplayName: 'OpenAI',
      fromProfileLabel: 'main@example.test',
      toProfileLabel: 'Backup profile',
      fromUsage: { label: 'Weekly', remainingPercent: 0 },
      toUsage: { label: 'Weekly', remainingPercent: 80 },
    });
  });

  it('suppresses external notifications for manual switches', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await dispatchConnectedServiceAccountSwitchNotificationAsync({
      settings: accountSettingsParse({
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
      }),
      expoPushSender: { sendToAllDevicesAsync },
      settingsSecretsReadKeys: [],
      runtimeQuotaSnapshots,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
          { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
        ],
      })),
      source: {
        sessionId: 'session-manual',
        sessionTitle: 'Fix checkout flow',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'manual',
      },
      nowMs: () => 2_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('suppresses external notifications for predictive fanout maintenance switches', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await dispatchConnectedServiceAccountSwitchNotificationAsync({
      settings: accountSettingsParse({
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
      }),
      expoPushSender: { sendToAllDevicesAsync },
      settingsSecretsReadKeys: [],
      runtimeQuotaSnapshots,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
          { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
        ],
      })),
      source: {
        sessionId: 'session-fanout',
        sessionTitle: 'Implement auth fanout',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'same_provider_account_exhausted',
      },
      nowMs: () => 2_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('surfaces the preventive copy for preemptive soft-threshold switches', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await dispatchConnectedServiceAccountSwitchNotificationAsync({
      settings: accountSettingsParse({
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
      }),
      expoPushSender: { sendToAllDevicesAsync },
      settingsSecretsReadKeys: [],
      runtimeQuotaSnapshots,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
          { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
        ],
      })),
      source: {
        sessionId: 'session-soft',
        sessionTitle: 'Preemptive swap',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
      },
      nowMs: () => 2_000,
      dedupeWindowMs: 0,
    });

    const [, body, data] = readOnlyPushNotificationCall(sendToAllDevicesAsync);
    expect(body).toContain('preventively');
    expect(data).toMatchObject({ reason: 'soft_threshold' });
  });

  it('does not expose provider account ids in outbound account-switch notifications', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async (
      _title: string,
      _body: string,
      _data: Record<string, unknown>,
    ) => {});
    const fetchSpy = vi.fn<FetchNotificationCall>(async () => ({
      ok: true,
      status: 202,
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    try {
      await dispatchConnectedServiceAccountSwitchNotificationAsync({
        settings: accountSettingsParse({
          notificationChannelsV1: [
            {
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
            },
            {
              v: 1,
              id: 'webhook-primary',
              kind: 'webhook',
              enabled: true,
              url: 'https://hooks.example.test/happier',
              signingSecret: null,
              topics: {
                ready: false,
                permissionRequest: false,
                userActionRequest: false,
                connectedServiceAccountSwitch: true,
                connectedServiceQuotaBlocked: false,
                connectedServiceQuotaRecovered: false,
              },
              readyIncludeMessageText: false,
            },
          ],
        }),
        expoPushSender: { sendToAllDevicesAsync },
        settingsSecretsReadKeys: [],
        runtimeQuotaSnapshots,
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [
            {
              profileId: 'primary',
              status: 'connected' as const,
              providerEmail: null,
              providerAccountId: 'acct-provider-primary-secret',
            },
            {
              profileId: 'backup',
              status: 'connected' as const,
              providerEmail: null,
              providerAccountId: 'acct-provider-backup-secret',
            },
          ],
        })),
        source: {
          sessionId: 'session-private-account-switch',
          sessionTitle: 'Fix checkout flow',
          serviceId: 'openai-codex',
          groupId: 'main',
          fromProfileId: 'primary',
          toProfileId: 'backup',
          reason: 'usage_limit',
        },
        nowMs: () => 2_000,
        dedupeWindowMs: 0,
      });

      const [_title, body, data] = readOnlyPushNotificationCall(sendToAllDevicesAsync);
      expect(body).not.toContain('acct-provider-primary-secret');
      expect(body).not.toContain('acct-provider-backup-secret');
      expect(data).toMatchObject({
        fromProfileLabel: 'primary',
        toProfileLabel: 'backup',
      });
      expect(JSON.stringify(data)).not.toContain('acct-provider-primary-secret');
      expect(JSON.stringify(data)).not.toContain('acct-provider-backup-secret');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchCall = fetchSpy.mock.calls[0];
      if (!fetchCall) throw new Error('Expected one webhook notification call');
      const payloadText = String(fetchCall[1]?.body);
      const payload = JSON.parse(payloadText);
      expect(payload.content.body).not.toContain('acct-provider-primary-secret');
      expect(payload.content.body).not.toContain('acct-provider-backup-secret');
      expect(payload.metadata).toMatchObject({
        fromProfileLabel: 'primary',
        toProfileLabel: 'backup',
      });
      expect(payloadText).not.toContain('acct-provider-primary-secret');
      expect(payloadText).not.toContain('acct-provider-backup-secret');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses provider short display names for Claude subscription switch notifications', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async (
      _title: string,
      _body: string,
      _data: Record<string, unknown>,
    ) => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await dispatchConnectedServiceAccountSwitchNotificationAsync({
      settings: accountSettingsParse({
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
      }),
      expoPushSender: { sendToAllDevicesAsync },
      settingsSecretsReadKeys: [],
      runtimeQuotaSnapshots,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
          { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
        ],
      })),
      source: {
        sessionId: 'session-claude',
        sessionTitle: null,
        serviceId: 'claude-subscription',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
      },
      nowMs: () => 2_000,
      dedupeWindowMs: 0,
    });

    const [title, body, data] = readOnlyPushNotificationCall(sendToAllDevicesAsync);
    expect(title).toBe('Claude account switched');
    expect(body).toContain('Claude');
    expect(body).not.toContain('Claude subscription');
    expect(data).toMatchObject({
      serviceDisplayName: 'Claude',
    });
  });

  it('normalizes auth failure reasons before dispatching user-facing notifications', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async (
      _title: string,
      _body: string,
      _data: Record<string, unknown>,
    ) => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await dispatchConnectedServiceAccountSwitchNotificationAsync({
      settings: accountSettingsParse({
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
      }),
      expoPushSender: { sendToAllDevicesAsync },
      settingsSecretsReadKeys: [],
      runtimeQuotaSnapshots,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'disabled', status: 'connected' as const, providerEmail: 'disabled@example.test' },
          { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
        ],
      })),
      source: {
        sessionId: 'session-auth',
        sessionTitle: 'Fix checkout flow',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'disabled',
        toProfileId: 'backup',
        reason: 'account_disabled',
      },
      nowMs: () => 2_000,
      dedupeWindowMs: 0,
    });

    const [_title, body, data] = readOnlyPushNotificationCall(sendToAllDevicesAsync);
    expect(body).toContain('credential stopped working');
    expect(body).not.toContain('account_disabled');
    expect(data).toMatchObject({
      reason: 'auth_invalid',
    });
  });
});

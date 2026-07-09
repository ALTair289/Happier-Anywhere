import type {
  AccountSettings,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/activity/notifications/dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from '@/activity/notifications/sendExpoPushActivityNotification';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { isBackgroundConnectedServiceSwitchReason } from '../connectedServiceSwitchEventVisibility';
import {
  loadConnectedServiceNotificationProfilesById,
  readConnectedServiceNotificationDisplayText,
  resolveConnectedServiceNotificationProfileLabel,
  resolveConnectedServiceNotificationServiceDisplayName,
  type ConnectedServiceNotificationProfileSummary,
} from './connectedServiceNotificationLabels';

export type ConnectedServiceAccountSwitchNotificationSource = Readonly<{
  sessionId: string;
  sessionTitle?: string | null;
  serviceId: string;
  groupId: string;
  fromProfileId: string | null;
  toProfileId: string | null;
  reason: string;
  limitCategory?: string | null;
  retryAfterMs?: number | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
}>;

function normalizeSwitchNotificationReason(reason: string): string {
  switch (reason) {
    case 'usage_limit':
    case 'rate_limit':
    case 'capacity':
      return 'usage_limit';
    case 'soft_threshold':
      return 'soft_threshold';
    case 'auth_invalid':
    case 'auth_expired':
    case 'account_disabled':
    case 'permission_denied':
    case 'refresh_failed':
    case 'refresh_failure':
      return 'auth_invalid';
    case 'manual':
      return 'manual';
    case 'account_changed':
      return 'account_changed';
    default:
      return 'account_changed';
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resolveUsageSummary(input: Readonly<{
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  serviceId: string;
  groupId: string;
  profileId: string | null;
}>): Readonly<{ label: string | null; remainingPercent: number }> | null {
  if (!input.profileId) return null;
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(input.serviceId);
  if (!serviceIdParsed.success) return null;
  const snapshot = input.runtimeQuotaSnapshots.getSnapshot({
    serviceId: serviceIdParsed.data,
    groupId: input.groupId,
    profileId: input.profileId,
  });
  if (!snapshot) return null;
  const candidates = snapshot.meters.flatMap((meter) => {
    if (typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)) {
      return [{
        label: readConnectedServiceNotificationDisplayText(meter.label) ?? readConnectedServiceNotificationDisplayText(meter.meterId),
        remainingPercent: clampPercent(meter.remainingPct),
      }];
    }
    if (typeof meter.utilizationPct === 'number' && Number.isFinite(meter.utilizationPct)) {
      return [{
        label: readConnectedServiceNotificationDisplayText(meter.label) ?? readConnectedServiceNotificationDisplayText(meter.meterId),
        remainingPercent: clampPercent(100 - meter.utilizationPct),
      }];
    }
    return [];
  });
  if (candidates.length === 0) return null;
  return candidates.reduce((mostConstrained, candidate) => (
    candidate.remainingPercent < mostConstrained.remainingPercent ? candidate : mostConstrained
  ));
}

export async function dispatchConnectedServiceAccountSwitchNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
  source: ConnectedServiceAccountSwitchNotificationSource;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  if (params.source.reason === 'manual') return;
  if (isBackgroundConnectedServiceSwitchReason(params.source.reason)) return;

  const profilesById = await loadConnectedServiceNotificationProfilesById({
    serviceId: params.source.serviceId,
    listConnectedServiceProfiles: params.listConnectedServiceProfiles,
  });
  const fromUsage = resolveUsageSummary({
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    serviceId: params.source.serviceId,
    groupId: params.source.groupId,
    profileId: params.source.fromProfileId,
  });
  const toUsage = resolveUsageSummary({
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    serviceId: params.source.serviceId,
    groupId: params.source.groupId,
    profileId: params.source.toProfileId,
  });
  await dispatchActivityNotificationAsync({
    settings: params.settings,
    settingsSecretsReadKeys: params.settingsSecretsReadKeys,
    expoPushSender: params.expoPushSender,
    event: {
      topic: 'connected_service_account_switch',
      sessionId: params.source.sessionId,
      sessionTitle: params.source.sessionTitle ?? null,
      serviceId: params.source.serviceId,
      serviceDisplayName: resolveConnectedServiceNotificationServiceDisplayName(params.source.serviceId),
      groupId: params.source.groupId,
      fromProfileId: params.source.fromProfileId,
      toProfileId: params.source.toProfileId,
      fromProfileLabel: resolveConnectedServiceNotificationProfileLabel(profilesById, params.source.fromProfileId),
      toProfileLabel: resolveConnectedServiceNotificationProfileLabel(profilesById, params.source.toProfileId),
      fromUsagePercent: fromUsage ? 100 - fromUsage.remainingPercent : null,
      toUsagePercent: toUsage ? 100 - toUsage.remainingPercent : null,
      fromUsage,
      toUsage,
      reason: normalizeSwitchNotificationReason(params.source.reason),
      limitCategory: params.source.limitCategory ?? null,
      retryAfterMs: params.source.retryAfterMs ?? null,
      quotaScope: params.source.quotaScope ?? null,
      providerLimitId: params.source.providerLimitId ?? null,
      action: params.source.action ?? null,
    },
    nowMs: params.nowMs,
    dedupeWindowMs: params.dedupeWindowMs,
  });
}

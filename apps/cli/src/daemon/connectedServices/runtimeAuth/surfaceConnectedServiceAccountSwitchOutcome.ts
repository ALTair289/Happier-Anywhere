import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import type { AccountSettings } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ExpoPushActivityNotificationSender } from '@/activity/notifications/sendExpoPushActivityNotification';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  dispatchConnectedServiceAccountSwitchNotificationAsync,
  type ConnectedServiceAccountSwitchNotificationSource,
} from '../notifications/dispatchConnectedServiceAccountSwitchNotification';
import type { ConnectedServiceNotificationProfileSummary } from '../notifications/connectedServiceNotificationLabels';
import { commitConnectedServiceAccountSwitchSessionEvent } from './commitConnectedServiceAccountSwitchSessionEvent';

/**
 * Single switch-outcome surfacing choke point.
 *
 * Every applied connected-service account switch (preemptive/soft, recovery/hard, manual, quota-driven)
 * routes through here so the two user-visible surfaces can never drift apart again:
 *   (a) the canonical session/transcript switch event, and
 *   (b) the user-facing activity notification.
 *
 * Reason policy lives in ONE owner, not here: `isBackgroundConnectedServiceSwitchReason`
 * (connectedServiceSwitchEventVisibility.ts), which the transcript committer and the notification
 * dispatcher BOTH read so the two surfaces stay symmetric. Today only `same_provider_account_exhausted`
 * (internal sibling fanout) is background/silent; `soft_threshold` (preemptive soft-swap) surfaces like
 * a hard-limit swap. The dispatcher additionally suppresses `manual`. Both surfaces are non-fatal: a
 * failure to surface never breaks a switch.
 */
export type SurfaceConnectedServiceAccountSwitchOutcomeRuntime = Readonly<{
  credentials: Credentials;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  listConnectedServiceProfiles: (input: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
  getConnectedServiceAuthGroup?: (input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<Readonly<{
    groupId: string;
    displayName?: string | null;
  }> | null>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  getActiveAccountSettingsSnapshot: () => Readonly<{
    settings: AccountSettings | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  }> | null;
  resolveSessionNotificationTitle: (sessionId: string) => string | null | undefined;
  nowMs?: () => number;
  dedupeWindowMs?: number;
  logDebug: (message: string, error: unknown) => void;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function readTrimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readOpenUrlAction(value: unknown): Readonly<{ kind: 'open_url'; url: string }> | null {
  const record = asRecord(value);
  if (!record || record.kind !== 'open_url' || typeof record.url !== 'string') return null;
  return { kind: 'open_url', url: record.url };
}

/**
 * Derive the notification source from either the rich group-switch event
 * (`connected_service_auth_group_switch`) or the raw account-switch record
 * (`connected_service_account_switch`). Returns `null` for any non-switch event
 * (deferral, attempt, degraded, restart-requested) — those commit a transcript event
 * but never notify. Reason-based suppression (manual/background) is left to the dispatcher.
 */
export function resolveConnectedServiceAccountSwitchNotificationSource(
  event: unknown,
  sessionId: string,
  resolveSessionNotificationTitle: (sessionId: string) => string | null | undefined,
): ConnectedServiceAccountSwitchNotificationSource | null {
  const record = asRecord(event);
  if (
    !record
    || (
      record.type !== 'connected_service_account_switch'
      && record.type !== 'connected_service_auth_group_switch'
    )
  ) return null;
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(record.serviceId);
  if (!serviceIdParsed.success) return null;
  const reason = readTrimmedOrNull(record.reason);
  if (!reason) return null;
  return {
    sessionId,
    sessionTitle: resolveSessionNotificationTitle(sessionId) ?? null,
    serviceId: serviceIdParsed.data,
    groupId: typeof record.groupId === 'string' ? record.groupId.trim() : '',
    fromProfileId: readTrimmedOrNull(record.fromProfileId),
    toProfileId: readTrimmedOrNull(record.toProfileId),
    reason,
    limitCategory: readTrimmedOrNull(record.limitCategory),
    retryAfterMs: readFiniteNumberOrNull(record.retryAfterMs),
    quotaScope: readTrimmedOrNull(record.quotaScope),
    providerLimitId: readTrimmedOrNull(record.providerLimitId),
    action: readOpenUrlAction(record.action),
  };
}

export function surfaceConnectedServiceAccountSwitchOutcome(
  runtime: SurfaceConnectedServiceAccountSwitchOutcomeRuntime,
  input: Readonly<{ sessionId: string; event: unknown }>,
): void {
  // (a) canonical transcript switch event — handles every event kind and self-suppresses
  // background/same-profile switches. Non-fatal.
  void commitConnectedServiceAccountSwitchSessionEvent({
    credentials: runtime.credentials,
    sessionId: input.sessionId,
    event: input.event,
    listConnectedServiceProfiles: runtime.listConnectedServiceProfiles,
    ...(runtime.getConnectedServiceAuthGroup
      ? { getConnectedServiceAuthGroup: runtime.getConnectedServiceAuthGroup }
      : {}),
  }).catch((error) => {
    runtime.logDebug('[DAEMON RUN] Failed to commit connected-service account switch session event (non-fatal)', error);
  });

  // (b) user-facing activity notification — only for applied account switches; the dispatcher
  // self-suppresses manual + background reasons. Non-fatal.
  const source = resolveConnectedServiceAccountSwitchNotificationSource(
    input.event,
    input.sessionId,
    runtime.resolveSessionNotificationTitle,
  );
  if (!source) return;
  const settingsSnapshot = runtime.getActiveAccountSettingsSnapshot();
  void dispatchConnectedServiceAccountSwitchNotificationAsync({
    settings: settingsSnapshot?.settings ?? null,
    settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
    ...(runtime.expoPushSender ? { expoPushSender: runtime.expoPushSender } : {}),
    runtimeQuotaSnapshots: runtime.runtimeQuotaSnapshots,
    listConnectedServiceProfiles: runtime.listConnectedServiceProfiles,
    source,
    ...(runtime.nowMs ? { nowMs: runtime.nowMs } : {}),
    ...(runtime.dedupeWindowMs !== undefined ? { dedupeWindowMs: runtime.dedupeWindowMs } : {}),
  }).catch((error) => {
    runtime.logDebug('[DAEMON RUN] Connected-service account switch notification failed (non-fatal)', error);
  });
}

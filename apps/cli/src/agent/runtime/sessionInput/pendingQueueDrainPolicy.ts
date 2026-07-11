import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
  SessionPendingQueueDeliveryTimingSchema,
  SessionPendingQueueDrainModeSchema,
  isSessionRuntimeActivityProjectionIdleForPendingDrain,
  type AccountSettings,
  type SessionRuntimeActivityProjectionForPendingDrain,
  type SessionPendingQueueDeliveryTiming,
  type SessionPendingQueueDrainMode,
} from '@happier-dev/protocol';
import type { PendingMaterializationActiveTurnPolicy } from './types';

export const PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE = 1;
export const PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE = 25;

export function resolveSessionPendingQueueDrainMode(
  settings: Pick<AccountSettings, 'sessionPendingQueueDrainMode'> | null | undefined,
): SessionPendingQueueDrainMode {
  const parsed = SessionPendingQueueDrainModeSchema.safeParse(settings?.sessionPendingQueueDrainMode);
  return parsed.success ? parsed.data : DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE;
}

export function resolveSessionPendingQueueMaxPopPerWake(
  settings: Pick<AccountSettings, 'sessionPendingQueueDrainMode'> | null | undefined,
): number {
  return resolveSessionPendingQueueDrainMode(settings) === 'drain_all'
    ? PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE
    : PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE;
}

export function resolveSessionPendingActiveTurnDeliveryPolicy(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): PendingMaterializationActiveTurnPolicy | undefined {
  return settings?.sessionBusySteerSendPolicy === 'server_pending'
    ? undefined
    : 'allow_live_delivery';
}

export type PendingQueueRuntimeActivityProjection = SessionRuntimeActivityProjectionForPendingDrain;

export function resolveSessionPendingQueueDeliveryTiming(
  settings: Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'> | null | undefined,
): SessionPendingQueueDeliveryTiming {
  const parsed = SessionPendingQueueDeliveryTimingSchema.safeParse(settings?.sessionPendingQueueDeliveryTiming);
  return parsed.success ? parsed.data : DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING;
}

export function runtimeIdleForPendingDrain(
  activity: PendingQueueRuntimeActivityProjection | null | undefined,
  nowMs: unknown,
  opts: Readonly<{ ownerLive?: boolean }> = {},
): boolean {
  return isSessionRuntimeActivityProjectionIdleForPendingDrain(activity, nowMs, opts);
}

function readRuntimeActivityExpiry(activity: PendingQueueRuntimeActivityProjection | null | undefined): number | null {
  const value = activity?.runtimeActivityExpiresAt;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readNowMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export type PendingQueueRuntimeActivityDeferral = Readonly<{
  defer: boolean;
  runtimeActivityExpiresAt: number | null;
}>;

export function resolvePendingQueueRuntimeActivityDeferral(params: Readonly<{
  settings: Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
  ownerLive?: boolean;
}>): PendingQueueRuntimeActivityDeferral {
  const runtimeActivityExpiresAt = readRuntimeActivityExpiry(params.activity);
  const nowMs = readNowMs(params.nowMs);
  const hasFutureExpiry = runtimeActivityExpiresAt !== null
    && nowMs !== null
    && runtimeActivityExpiresAt > nowMs;
  const defer = resolveSessionPendingQueueDeliveryTiming(params.settings) === 'after_runtime_idle'
    && !runtimeIdleForPendingDrain(params.activity, params.nowMs, { ownerLive: params.ownerLive });
  return {
    defer,
    runtimeActivityExpiresAt: defer && hasFutureExpiry ? runtimeActivityExpiresAt : null,
  };
}

export function shouldDeferPendingQueueDrainForRuntimeActivity(params: Readonly<{
  settings: Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
  ownerLive?: boolean;
}>): boolean {
  return resolvePendingQueueRuntimeActivityDeferral(params).defer;
}

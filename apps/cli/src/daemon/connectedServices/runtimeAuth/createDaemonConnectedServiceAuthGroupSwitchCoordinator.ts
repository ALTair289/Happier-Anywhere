import {
  ConnectedServiceIdSchema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceAuthGroupMemberStateV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
  type ConnectedServiceAuthGroupSwitchEvent,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { evaluatePredictiveSoftSwitchSessionApplyPolicy } from '../accountGroups/switching/predictiveSoftSwitchPolicy';
import {
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  type AccountUsageStoreForAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import { createConnectedServiceAuthGenerationApplyFailureError } from './connectedServiceAuthGenerationApplyFailure';
import type { ConnectedServiceSessionAuthSwitchReason } from './connectedServiceSessionAuthSwitchCore';

type AuthGroupApi = Readonly<{
  getConnectedServiceAuthGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupActiveProfile(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    expectedGeneration: number;
    overrideRuntimeCooldown?: boolean;
  }>): Promise<ConnectedServiceAuthGroupV1>;
  updateConnectedServiceAuthGroupRuntimeState?(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration: number;
    memberStates: ReadonlyArray<Readonly<{
      profileId: string;
      state: ConnectedServiceAuthGroupMemberStateV1;
    }>>;
  }>): Promise<ConnectedServiceAuthGroupV1>;
  listConnectedServiceProfiles?(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceCredentialHealthStatusV1;
    }>>;
  }>>;
}>;

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function resolveLimiterRetryAtMs(input: Readonly<{
  loaded: ConnectedServiceAuthGroupSwitchState;
  retryAtMs: number | null;
  observedAtMs: number;
}>): number | null {
  if (input.retryAtMs !== null) return input.retryAtMs;
  const cooldownMs = readNonNegativeNumber(input.loaded.policy.cooldownMs);
  return cooldownMs === null ? null : input.observedAtMs + cooldownMs;
}

function resolveAuthFailureRetryAtMs(input: Readonly<{
  loaded: ConnectedServiceAuthGroupSwitchState;
  retryAtMs: number | null;
  observedAtMs: number;
}>): number | null {
  if (input.retryAtMs !== null) return input.retryAtMs;
  const cooldownMs = readNonNegativeNumber(input.loaded.policy.cooldownMs);
  return cooldownMs === null ? null : input.observedAtMs + cooldownMs;
}

function assertPredictiveSoftSwitchSessionApplyAllowed(input: Readonly<{
  reason: string;
  sessionId?: string;
  applyMode?: 'hot_apply' | 'restart_resume' | 'spawn_next_turn' | null;
}>): void {
  const decision = evaluatePredictiveSoftSwitchSessionApplyPolicy({
    reason: input.reason as Parameters<typeof evaluatePredictiveSoftSwitchSessionApplyPolicy>[0]['reason'],
    sessionId: input.sessionId,
    applyMode: input.applyMode ?? undefined,
  });
  if (decision.status === 'allow') return;
  throw createConnectedServiceAuthGenerationApplyFailureError({
    errorCode: 'hot_apply_restart_required',
    diagnostics: {
      policyReason: decision.reason,
      ...(input.applyMode ? { attemptedMode: input.applyMode } : {}),
    },
  });
}

function mapConnectedServiceAuthGenerationActionToApplyMode(
  action: string | undefined,
): 'hot_apply' | 'restart_resume' | 'spawn_next_turn' | null {
  switch (action) {
    case 'hot_applied':
      return 'hot_apply';
    case 'metadata_updated':
      return 'spawn_next_turn';
    case 'restart_requested':
      return 'restart_resume';
    default:
      return null;
  }
}

function buildObservedFailureMemberState(input: Readonly<{
  loaded: ConnectedServiceAuthGroupSwitchState;
  profileId: string;
  reason: string;
  retryAtMs: number | null;
  planType: string | null | undefined;
  observedAtMs: number;
}>): ConnectedServiceAuthGroupMemberStateV1 {
  const existing = input.loaded.memberStatesByProfileId.get(input.profileId) ?? {};
  const state: ConnectedServiceAuthGroupMemberStateV1 = {
    ...(existing.cooldownUntilMs === undefined ? {} : { cooldownUntilMs: existing.cooldownUntilMs }),
    ...(existing.exhaustedUntilMs === undefined ? {} : { exhaustedUntilMs: existing.exhaustedUntilMs }),
    ...(existing.quotaExhaustedUntilMs === undefined ? {} : { quotaExhaustedUntilMs: existing.quotaExhaustedUntilMs }),
    ...(existing.rateLimitedUntilMs === undefined ? {} : { rateLimitedUntilMs: existing.rateLimitedUntilMs }),
    ...(existing.capacityLimitedUntilMs === undefined ? {} : { capacityLimitedUntilMs: existing.capacityLimitedUntilMs }),
    ...(existing.authInvalidUntilMs === undefined ? {} : { authInvalidUntilMs: existing.authInvalidUntilMs }),
    ...(existing.planUnavailableUntilMs === undefined ? {} : { planUnavailableUntilMs: existing.planUnavailableUntilMs }),
    ...(existing.validationBlockedUntilMs === undefined ? {} : { validationBlockedUntilMs: existing.validationBlockedUntilMs }),
    lastFailureKind: input.reason,
    lastObservedAtMs: input.observedAtMs,
    ...(input.planType ? { lastObservedPlanType: input.planType } : {}),
  };
  switch (input.reason) {
    case 'usage_limit':
      return { ...state, quotaExhaustedUntilMs: resolveLimiterRetryAtMs(input) };
    case 'rate_limit':
      return { ...state, rateLimitedUntilMs: resolveLimiterRetryAtMs(input) };
    case 'capacity':
      return { ...state, capacityLimitedUntilMs: resolveLimiterRetryAtMs(input) };
    case 'auth_expired':
    case 'refresh_failed':
    case 'account_disabled':
      return {
        ...state,
        authInvalidUntilMs: resolveAuthFailureRetryAtMs(input),
      };
    case 'plan':
      return { ...state, planUnavailableUntilMs: input.retryAtMs };
    case 'validation':
      return { ...state, validationBlockedUntilMs: input.retryAtMs };
    default:
      return state;
  }
}

function resolveRetryAtMs(input: Readonly<{
  retryAtMs?: number | null;
  retryAfterMs?: number | null;
  resetsAtMs?: number | null;
  nowMs: number;
}>): number | null {
  const resetsAtMs = readNonNegativeNumber(input.resetsAtMs);
  if (resetsAtMs !== null) return resetsAtMs;
  const retryAfterMs = readNonNegativeNumber(input.retryAfterMs);
  if (retryAfterMs !== null) return input.nowMs + retryAfterMs;
  return readNonNegativeNumber(input.retryAtMs);
}

function resolveApiAuthGroupGenerationConflict(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  if (error.message !== 'connected_service_auth_group_generation_conflict') return null;
  return readNonNegativeNumber((error as Readonly<{ generation?: unknown }>).generation);
}

// Bounded retry for the idempotent auth-group read that gates every switch. A transient
// local-server blip previously threw at the first step of recovery and was swallowed as
// `recovery_handler_failed` with no follow-up, permanently dropping a correctly-classified
// usage-limit switch (observed across several sessions during a server-timeout window).
const AUTH_GROUP_LOAD_RETRY_ATTEMPTS = 2;
const AUTH_GROUP_LOAD_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_GROUP_QUOTA_PROBE_TIMEOUT_MS = 8_000;

function defaultSwitchCoordinatorSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConnectedServiceAuthGroupWithRetry(input: Readonly<{
  api: AuthGroupApi;
  serviceId: ConnectedServiceId;
  groupId: string;
  attempts: number;
  baseDelayMs: number;
  sleepMs: (ms: number) => Promise<void>;
}>): Promise<ConnectedServiceAuthGroupV1 | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.api.getConnectedServiceAuthGroup({
        serviceId: input.serviceId,
        groupId: input.groupId,
      });
    } catch (error) {
      // A generation conflict is a real state mismatch the coordinator resolves explicitly, not
      // a transient blip — surface it immediately. Everything else thrown by the idempotent GET
      // (timeout/ECONNABORTED/network/5xx) is treated as transient and retried with backoff.
      if (attempt >= input.attempts || resolveApiAuthGroupGenerationConflict(error) !== null) {
        throw error;
      }
      await input.sleepMs(input.baseDelayMs * (attempt + 1));
    }
  }
}

function resolveGroupQuotaProbeTimeoutMs(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (value === undefined) return DEFAULT_GROUP_QUOTA_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_GROUP_QUOTA_PROBE_TIMEOUT_MS;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

async function runQuotaSnapshotProbeWithTimeout(input: Readonly<{
  timeoutMs: number | null;
  probe: () => Promise<void>;
}>): Promise<void> {
  if (input.timeoutMs === null) {
    await input.probe();
    return;
  }

  const timeoutMs = input.timeoutMs;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const probePromise = input.probe().then(
    () => ({ status: 'completed' as const }),
    (error) => ({ status: 'failed' as const, error }),
  );
  const timeoutPromise = new Promise<Readonly<{ status: 'timed_out' }>>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ status: 'timed_out' });
    }, timeoutMs);
    (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
  });

  const result = await Promise.race([probePromise, timeoutPromise]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  timeoutHandle = null;
  if (result.status === 'timed_out') return;
  if (result.status === 'failed') throw result.error;
}

export function createDaemonConnectedServiceAuthGroupSwitchCoordinator(params: Readonly<{
  api: AuthGroupApi;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
  leases?: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry;
  quotaFreshnessMs: number;
  nowMs: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  restartSession: (input: Readonly<{
    sessionId?: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    reason?: string;
  }>) => Promise<void>;
  applyConnectedServiceAuthGeneration?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    reason: string;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    fromProfileId?: string | null;
  }>) => Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string; diagnostics?: unknown }>>;
  preflightConnectedServiceAuthGeneration?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    reason: string;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    fromProfileId?: string | null;
  }>) => Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string; diagnostics?: unknown }>>;
  switchReasonForApplyGeneration?: ConnectedServiceSessionAuthSwitchReason;
  hydratePersistedQuotaSnapshotsForGroup?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>) => Promise<void>;
  probeQuotaSnapshotsForGroup?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
    reason: string;
  }>) => Promise<void>;
  quotaProbeTimeoutMs?: number | null;
  onCommittedSwitch?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    generation: number;
    expectedGeneration?: number;
  }>) => Promise<void> | void;
  emitEvent?: (event: ConnectedServiceAuthGroupSwitchEvent) => void;
}>): ConnectedServiceAuthGroupSwitchCoordinator {
  return new ConnectedServiceAuthGroupSwitchCoordinator({
    leases: params.leases ?? new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    loadState: async (input) => {
      const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
      const group = await loadConnectedServiceAuthGroupWithRetry({
        api: params.api,
        serviceId,
        groupId: input.groupId,
        attempts: AUTH_GROUP_LOAD_RETRY_ATTEMPTS,
        baseDelayMs: AUTH_GROUP_LOAD_RETRY_BASE_DELAY_MS,
        sleepMs: params.sleepMs ?? defaultSwitchCoordinatorSleepMs,
      });
      if (!group) throw new Error(`Connected service auth group not found (${input.serviceId}/${input.groupId})`);
      const sourceBackedState = params.accountUsageStore
        ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
          group,
          accountUsageStore: params.accountUsageStore,
        })?.state ?? null
        : null;
      const state = sourceBackedState ?? (
        buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group })
      );
      if (typeof params.api.listConnectedServiceProfiles !== 'function') return state;
      const profiles = await params.api.listConnectedServiceProfiles({ serviceId }).catch(() => null);
      if (!profiles) return state;
      const healthByProfileId = new Map(profiles.profiles.map((profile) => [profile.profileId, profile.status]));
      const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
      for (const member of state.members) {
        const healthStatus = healthByProfileId.get(member.profileId);
        if (!healthStatus) continue;
        memberStatesByProfileId.set(member.profileId, {
          ...(memberStatesByProfileId.get(member.profileId) ?? {}),
          credentialHealthStatus: healthStatus,
        });
      }
      return {
        ...state,
        memberStatesByProfileId,
      };
    },
    commitSwitch: async (input) => {
      const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
      const group = await params.api.updateConnectedServiceAuthGroupActiveProfile({
        serviceId,
        groupId: input.groupId,
        activeProfileId: input.toProfileId,
        expectedGeneration: input.expectedGeneration,
        overrideRuntimeCooldown: true,
      });
      await params.onCommittedSwitch?.({
        serviceId,
        groupId: input.groupId,
        activeProfileId: input.toProfileId,
        generation: group.generation,
        ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }),
      });
      return params.accountUsageStore
        ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
          group,
          accountUsageStore: params.accountUsageStore,
        })?.state ?? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group })
        : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group });
    },
    ...(params.probeQuotaSnapshotsForGroup ? {
      probeQuotaSnapshotsForGroup: async (input) => {
        const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
        await runQuotaSnapshotProbeWithTimeout({
          timeoutMs: resolveGroupQuotaProbeTimeoutMs(params.quotaProbeTimeoutMs),
          probe: async () => {
            await params.probeQuotaSnapshotsForGroup?.({
              serviceId,
              groupId: input.groupId,
              profileIds: input.profileIds,
              reason: input.reason,
            });
          },
        });
      },
    } : {}),
    resolveGenerationConflict: resolveApiAuthGroupGenerationConflict,
    ...(params.preflightConnectedServiceAuthGeneration ? {
      preflightApplyGeneration: async (input) => {
        if (!input.sessionId) return undefined;
        const applied = await params.preflightConnectedServiceAuthGeneration?.({
          sessionId: input.sessionId,
          serviceId: input.serviceId as ConnectedServiceId,
          groupId: input.groupId,
          activeProfileId: input.activeProfileId,
          generation: input.generation,
          reason: input.reason ?? 'unknown',
          switchReason: params.switchReasonForApplyGeneration ?? 'automatic_runtime_failure',
          fromProfileId: input.fromProfileId ?? null,
        });
        if (applied?.ok) {
          const mode = mapConnectedServiceAuthGenerationActionToApplyMode(applied.action);
          assertPredictiveSoftSwitchSessionApplyAllowed({
            reason: input.reason ?? 'unknown',
            sessionId: input.sessionId,
            applyMode: mode,
          });
          return {
            ...(mode === null ? {} : { mode }),
            ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
          };
        }
        throw createConnectedServiceAuthGenerationApplyFailureError({
          errorCode: applied?.errorCode ?? 'unknown',
          ...(applied?.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
        });
      },
    } : {}),
    applyGeneration: async (input) => {
      if (input.sessionId && params.applyConnectedServiceAuthGeneration) {
        const applied = await params.applyConnectedServiceAuthGeneration({
          sessionId: input.sessionId,
          serviceId: input.serviceId as ConnectedServiceId,
          groupId: input.groupId,
          activeProfileId: input.activeProfileId,
          generation: input.generation,
          reason: input.reason ?? 'unknown',
          switchReason: params.switchReasonForApplyGeneration ?? 'automatic_runtime_failure',
          fromProfileId: input.fromProfileId ?? null,
        });
        if (applied.ok) {
          // Map only REAL transitions to an apply mode. An `unchanged` apply performed no restart
          // and no provider application — reporting it as `restart_resume`/`applied` fabricates a
          // transition that never happened (RD-SW-5), so it yields no mode at all.
          const mode = mapConnectedServiceAuthGenerationActionToApplyMode(applied.action);
          assertPredictiveSoftSwitchSessionApplyAllowed({
            reason: input.reason ?? 'unknown',
            sessionId: input.sessionId,
            applyMode: mode,
          });
          // INC-6: forward the FSM-proven continuity diagnostics so the coordinator result (and
          // the reactive switch-attempt telemetry that reads it) is not all-null.
          return {
            ...(mode === null ? {} : { mode }),
            ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
          };
        }
        throw createConnectedServiceAuthGenerationApplyFailureError({
          errorCode: applied.errorCode ?? 'unknown',
          ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
        });
      }
      assertPredictiveSoftSwitchSessionApplyAllowed({
        reason: input.reason ?? 'unknown',
        sessionId: input.sessionId,
        applyMode: 'restart_resume',
      });
      await params.restartSession({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        serviceId: input.serviceId as ConnectedServiceId,
        groupId: input.groupId,
        activeProfileId: input.activeProfileId,
        generation: input.generation,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return { mode: 'restart_resume' as const };
    },
    recordObservedFailureState: async (input) => {
      if (!params.api.updateConnectedServiceAuthGroupRuntimeState) return;
      const observedProfileId = typeof input.observedProfileId === 'string' && input.observedProfileId.trim().length > 0
        ? input.observedProfileId.trim()
        : input.loaded.activeProfileId;
      if (!observedProfileId) return;
      const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
      await params.api.updateConnectedServiceAuthGroupRuntimeState({
        serviceId,
        groupId: input.groupId,
        expectedGeneration: input.loaded.generation,
        memberStates: [{
          profileId: observedProfileId,
          state: buildObservedFailureMemberState({
            loaded: input.loaded,
            profileId: observedProfileId,
            reason: input.reason,
            retryAtMs: resolveRetryAtMs({
              retryAtMs: input.retryAtMs,
              retryAfterMs: input.retryAfterMs,
              resetsAtMs: input.resetsAtMs,
              nowMs: params.nowMs(),
            }),
            planType: input.planType,
            observedAtMs: params.nowMs(),
          }),
        }],
      });
    },
    ...(params.emitEvent ? { emitEvent: params.emitEvent } : {}),
  });
}

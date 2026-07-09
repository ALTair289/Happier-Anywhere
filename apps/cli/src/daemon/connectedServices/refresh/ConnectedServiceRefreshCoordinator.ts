import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import {
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';
import { createCodexChatGptBridgeRefreshHooks } from '@/backends/codex/connectedServices/createCodexChatGptBridgeRefreshHooks';
import {
  type ClaudeSubscriptionAuthTokensRefreshResponse,
  type ClaudeSubscriptionAuthTokensRefreshSelection,
} from '@/backends/claude/connectedServices/claudeSubscriptionAuthTokensRefreshBridgeContract';
import { createClaudeSubscriptionBridgeRefreshHooks } from '@/backends/claude/connectedServices/createClaudeSubscriptionBridgeRefreshHooks';
import type {
  ConnectedServiceBridgeRefreshCapabilities,
  ConnectedServiceBridgeRefreshProfileHooks,
} from './bridgeRefreshHooks';
import { computeConnectedServiceAccessTokenFingerprint } from './credentialFreshness/tokenFingerprint';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { materializeConnectedServicesForSpawn } from '../materialize/materializeConnectedServicesForSpawn';
import { collectBlockingConnectedServicesMaterializationDiagnostics } from '../materialize/providerMaterializerTypes';
import { refreshConnectedAccountOauthTokens } from './serviceRefreshers';
import { ConnectedServiceOauthRefreshError } from './serviceRefreshers';
import { resolveForcedRefreshFreshnessDecision } from './credentialFreshness/adoptFreshFirst';
import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type {
  ConnectedServiceCredentialLifecycleDescriptor,
  ConnectedServiceRefreshReason,
} from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { readConnectedServiceMaterializationIdentityV1 } from '../materialize/createConnectedServiceMaterializationIdentity';
import {
  ConnectedServiceRuntimeRegistry,
} from '../runtimeRegistry/registry';
import {
  ConnectedServiceBridgeSelectionAuthorizationError,
  resolveCurrentBridgeSelectionForTarget,
} from './bridgeAuthorization';
import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import {
  buildMaterializationFailureRefreshResult,
  buildMissingRuntimeAuthTargetRefreshResult,
  buildRefreshDiagnostic,
  isReauthRequiredFailure,
  persistCredentialHealthForMaterializationFailure,
  persistCredentialHealthForRefreshResult,
} from './refreshDiagnostics';
import {
  canReprobeCredentialHealth,
  credentialHealthReprobeDelayMs,
  isReconnectRequiredProfileStatus,
  readCredentialHealthStatusForRefresh,
  shouldBlockRefreshForCredentialHealth,
  type CredentialHealthReprobeState,
} from './credentialHealthReprobe';
import {
  buildUpdatedOauthRecord,
  hasObservedOauthCredentialChanged,
} from './oauthCredentialRecords';
import {
  persistRefreshedCredential,
  readCredentialForRefresh,
} from './credentialStore';
import {
  clearRegisteredGroupMemberRuntimeStateWithPositiveEvidence,
} from './memberRuntimeStateEvidence';
import {
  buildResolvedSelectionsForTarget,
  canonicalizeTargetSelectionsForRematerialization,
  resolveSpawnTargetMaterializationIdentity,
} from './rematerialization';
import type {
  BoundProfile,
  ConnectedServiceCredentialHealthNotificationStatus,
  ConnectedServiceCredentialHealthNotificationTarget,
  ConnectedServiceCredentialRefreshDiagnostic,
  ConnectedServiceCredentialRefreshResult,
  ConnectedServiceCredentialSource,
  ConnectedServiceQuotaCredentialRefreshOutcome,
  RematerializedTargetsResult,
  RematerializedTargetFailure,
  SpawnTarget,
} from './refreshTypes';

export type {
  ConnectedServiceCredentialHealthNotificationStatus,
  ConnectedServiceCredentialHealthNotificationTarget,
  ConnectedServiceCredentialRefreshDiagnostic,
  ConnectedServiceCredentialRefreshResult,
  ConnectedServiceCredentialRefreshStatus,
} from './refreshTypes';
export {
  CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
  ConnectedServiceBridgeSelectionAuthorizationError,
  isConnectedServiceBridgeSelectionAuthorizationError,
} from './bridgeAuthorization';
export type {
  ConnectedServiceMaterializationCredentialRefreshClassification,
} from './refreshDiagnostics';
export {
  classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh,
} from './refreshDiagnostics';

function bindingKey(binding: BoundProfile): string {
  return `${binding.serviceId}/${binding.profileId}`;
}

/**
 * A forced caller may adopt an already-in-flight refresh only when that refresh actually
 * exercised (or attempted) a rotation. A `not_needed` early-return performed no rotation, so a
 * forced caller must still run its own refresh; every other outcome is either a real rotation or a
 * terminal condition that a duplicate concurrent refresh would not improve.
 */
function inFlightResultSatisfiesCaller(
  result: ConnectedServiceCredentialRefreshResult,
  caller: Readonly<{ force: boolean }>,
): boolean {
  if (!caller.force) return true;
  return result.status !== 'not_needed';
}

async function defaultSleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, Math.trunc(ms)));
    (timeout as unknown as { unref?: () => void }).unref?.();
  });
}

function resolveRuntimeAuthRematerializationFailures(input: Readonly<{
  result: RematerializedTargetsResult;
  sessionId: string | null;
}>): ReadonlyArray<RematerializedTargetFailure> {
  if (input.sessionId) {
    const sessionFailures = input.result.failedTargets.filter((failure) => failure.target.sessionId === input.sessionId);
    if (sessionFailures.length > 0) return sessionFailures;
    const sessionWasAffected = input.result.affectedTargets.some((target) => target.sessionId === input.sessionId);
    return sessionWasAffected ? [] : input.result.failedTargets;
  }
  if (input.result.affectedTargets.length === 0) return [];
  if (input.result.rematerializedTargets.length > 0) return [];
  return input.result.failedTargets;
}

function wasRuntimeAuthSessionRematerialized(input: Readonly<{
  result: RematerializedTargetsResult;
  sessionId: string | null;
}>): boolean {
  if (!input.sessionId) return true;
  return input.result.rematerializedTargets.some((target) => target.sessionId === input.sessionId);
}

export class ConnectedServiceCredentialRefreshError extends Error {
  readonly diagnostic: ConnectedServiceCredentialRefreshDiagnostic;

  constructor(diagnostic: ConnectedServiceCredentialRefreshDiagnostic) {
    super(`Connected service credential refresh failed: ${diagnostic.serviceId}/${diagnostic.profileId} ${diagnostic.category ?? 'unknown'}`);
    this.name = 'ConnectedServiceCredentialRefreshError';
    this.diagnostic = diagnostic;
  }
}

export class ConnectedServiceRefreshCoordinator {
  private readonly runtimeRegistry: ConnectedServiceRuntimeRegistry;
  private readonly inFlightRefreshes = new Map<string, Promise<ConnectedServiceCredentialRefreshResult>>();
  private readonly inFlightRefreshRematerializations = new Map<string, Promise<RematerializedTargetsResult>>();
  private readonly inFlightRefreshAuthUpdatedNotifications = new Map<string, Promise<void>>();
  /** RR-1 reentrancy guard: bindings currently mid-distribution on the 'refreshed' completion path. */
  private readonly distributingRefreshedBindings = new Set<string>();
  private readonly canonicalGroupStateCache = new Map<string, Readonly<{
    atMs: number;
    group: Readonly<{ activeProfileId: string | null; generation: number }> | null;
  }>>();
  private readonly credentialHealthReprobeState = new Map<string, CredentialHealthReprobeState>();

  constructor(private readonly params: Readonly<{
    api: ApiClient;
    credentials: Credentials;
    machineIdProvider: () => string;
    ownerIdProvider?: () => string | null | undefined;
    activeServerDir: string;
    baseDir: string;
    refreshWindowMs: number;
    refreshLeaseMs: number;
    leaseContentionWaitMaxMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    now: () => number;
    accountSettingsProvider?: () => AccountSettings | Readonly<Record<string, unknown>> | null | undefined;
    processEnv?: NodeJS.ProcessEnv;
    onAuthUpdated?: (event: Readonly<{
      binding: BoundProfile;
      affectedTargets: ReadonlyArray<SpawnTarget>;
      trigger: 'refresh_triggered_restart' | 'reconnect_propagation';
    }>) => void | Promise<void>;
    onCredentialHealthNotification?: (event: Readonly<{
      diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
      healthStatus: ConnectedServiceCredentialHealthNotificationStatus;
      affectedTargets: ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget>;
    }>) => void | Promise<void>;
    logRefreshDiagnostic?: (diagnostic: ConnectedServiceCredentialRefreshDiagnostic) => void;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    /**
     * Resolves a provider's credential lifecycle descriptor (RR-9). The coordinator consumes the
     * descriptor's `materializedHomeMaintenance` hook rather than importing provider-specific
     * freshness logic. Defaults to the canonical catalog resolver.
     */
    resolveLifecycleDescriptor?: (
      agentId: CatalogAgentId,
    ) => Promise<ConnectedServiceCredentialLifecycleDescriptor>;
  }>) {
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry();
  }

  registerSpawnTarget(params: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    sessionId?: string | null;
    brokerSelectionIdentity?: string | null;
    materializationKey: string;
    /** Tracked session materialization identity; keeps rematerialization on the live `csm_*` root. */
    connectedServiceMaterializationIdentityV1?: unknown;
    /** Tracked session working directory; keeps workspace-trust projection on the session cwd. */
    sessionDirectory?: string | null;
    connectedServicesBindingsRaw: unknown;
    connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>;
  }>): void {
    this.runtimeRegistry.registerTarget({
      pid: params.pid,
      agentId: params.agentId,
      sessionId: typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : null,
      ...(typeof params.brokerSelectionIdentity === 'string' && params.brokerSelectionIdentity.trim().length > 0
        ? { brokerSelectionIdentity: params.brokerSelectionIdentity.trim() }
        : {}),
      materializationKey: params.materializationKey,
      connectedServiceMaterializationIdentityV1: readConnectedServiceMaterializationIdentityV1(
        params.connectedServiceMaterializationIdentityV1,
      ),
      sessionDirectory: typeof params.sessionDirectory === 'string' && params.sessionDirectory.trim().length > 0
        ? params.sessionDirectory.trim()
        : null,
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(params.connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv: params.connectedServiceSelectionsEnv } : {}),
    });
  }

  unregisterPid(pid: number): void {
    this.runtimeRegistry.unregisterPid(pid);
  }

  transferPid(fromPid: number, toPid: number): void {
    this.runtimeRegistry.transferPid(fromPid, toPid);
  }

  async tickOnce(): Promise<void> {
    const now = this.params.now();
    const unique = new Map<string, BoundProfile>();
    const errors: unknown[] = [];

    for (const target of this.runtimeRegistry.listRefreshTargets()) {
      for (const binding of target.bindings) {
        unique.set(bindingKey(binding), binding);
      }
    }

    for (const binding of unique.values()) {
      try {
        await this.maybeRefreshBinding(binding, now);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Connected services refresh tick failed');
    }
  }

  async refreshOpenAiCodexChatGptTokensForBridge(input: Readonly<{
    sessionId?: string | null;
    /** Broker selection identity for shared-server providers (R3-6). Wire `selection` is IGNORED. */
    brokerSelectionIdentity?: string | null;
    selection?: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
    forceRefresh?: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>): Promise<CodexChatGptAuthTokensRefreshResponse> {
    return await this.refreshServiceTokensForBridge({
      serviceId: 'openai-codex',
      sessionId: input.sessionId,
      brokerSelectionIdentity: input.brokerSelectionIdentity,
      forceRefresh: input.forceRefresh,
      failingAccessTokenFingerprint: input.failingAccessTokenFingerprint,
      hooks: createCodexChatGptBridgeRefreshHooks({
        chatgptPlanType: input.chatgptPlanType,
        capabilities: this.bridgeRefreshCapabilities(),
      }),
    });
  }

  /**
   * Daemon-side handler for the OpenCode Claude broker bridge: deliver a fresh Anthropic ACCESS
   * token (never the refresh token). Reuses the canonical per-binding refresh (single-flight,
   * rotation-aware, persists the rotated refresh token) for subscription OAuth; setup-tokens are
   * long-lived access tokens and are returned as-is (nothing to refresh).
   */
  async refreshClaudeSubscriptionTokensForBridge(input: Readonly<{
    sessionId?: string | null;
    /**
     * Broker selection identity for shared-server providers (R3-6). Retained
     * `selection` on the wire is IGNORED for identity — the daemon re-resolves the current binding.
     */
    brokerSelectionIdentity?: string | null;
    selection?: ClaudeSubscriptionAuthTokensRefreshSelection;
    forceRefresh?: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>): Promise<ClaudeSubscriptionAuthTokensRefreshResponse> {
    return await this.refreshServiceTokensForBridge({
      serviceId: 'claude-subscription',
      sessionId: input.sessionId,
      brokerSelectionIdentity: input.brokerSelectionIdentity,
      forceRefresh: input.forceRefresh,
      failingAccessTokenFingerprint: input.failingAccessTokenFingerprint,
      hooks: createClaudeSubscriptionBridgeRefreshHooks({
        capabilities: this.bridgeRefreshCapabilities(),
      }),
    });
  }

  /**
   * CS-FIX-1: the ONE generic access-token bridge-refresh skeleton. It owns the SHARED orchestration
   * every provider bridge needs — the single authz choke point (R3-3/R3-6), the F6
   * adopt-current-if-valid freshness decision, the positive-evidence runtime-state clear, forced
   * distribution, and the single `refreshOauthBinding` rotation owner — and delegates ONLY the
   * provider-specific steps (profile resolution, current-token probe incl. setup-token short-circuit,
   * refreshed-response shaping incl. any post-rotation materialization) to the provider's bridge hook.
   * A new provider adds a hook module and a thin typed adapter above; the skeleton never changes.
   */
  private async refreshServiceTokensForBridge<TResponse>(input: Readonly<{
    serviceId: ConnectedServiceId;
    sessionId?: string | null;
    brokerSelectionIdentity?: string | null;
    forceRefresh?: boolean;
    failingAccessTokenFingerprint?: string | null;
    hooks: ConnectedServiceBridgeRefreshProfileHooks<TResponse>;
  }>): Promise<TResponse> {
    const selection = this.resolveAuthorizedBridgeSelectionForBridge({
      sessionId: input.sessionId,
      brokerSelectionIdentity: input.brokerSelectionIdentity,
      serviceId: input.serviceId,
    });
    const profileId = input.hooks.resolveProfileId(selection);
    const binding = { serviceId: input.serviceId, profileId };

    const probe = await input.hooks.probeCurrentToken(binding);
    if (probe.kind === 'non_refreshable') {
      this.logBridgeCurrentTokenAdoptionDiagnostic({
        serviceId: input.serviceId,
        profileId,
        reason: 'setup_token',
        accessToken: probe.accessToken,
      });
      return probe.response;
    }
    // F6: return the CURRENT access token if still valid + not forced (avoid rotating on every cold
    // broker cache-miss). The broker forces a rotation ONLY on its 401-retry path.
    if (probe.kind === 'adoptable') {
      const forceDecision = resolveForcedRefreshFreshnessDecision({
        force: input.forceRefresh === true,
        currentAccessToken: probe.accessToken,
        currentTokenAdoptable: true,
        failingAccessTokenFingerprint: input.failingAccessTokenFingerprint,
      });
      if (input.forceRefresh !== true || forceDecision.kind === 'adopt_current') {
        await clearRegisteredGroupMemberRuntimeStateWithPositiveEvidence({
          api: this.params.api,
          runtimeRegistry: this.runtimeRegistry,
          binding,
          evidence: { kind: 'oauth_token_callback', observedAtMs: this.params.now() },
        });
        if (input.forceRefresh === true) {
          await this.distributeRefreshedBinding(binding);
        }
        this.logBridgeCurrentTokenAdoptionDiagnostic({
          serviceId: input.serviceId,
          profileId,
          reason: input.forceRefresh === true ? 'adopted_current' : 'not_needed',
          accessToken: probe.accessToken,
        });
        return probe.buildResponse();
      }
    }

    const updated = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { force: true, reason: 'provider_auth_bridge' },
    );
    if (updated.status !== 'refreshed' || updated.credential?.kind !== 'oauth') {
      throw new Error(input.hooks.refreshUnavailableErrorCode);
    }
    return await input.hooks.finalizeRefreshedResponse({
      binding,
      selection,
      credential: updated.credential,
    });
  }

  /**
   * Coordinator-owned runtime capabilities exposed to provider bridge hooks (CS-FIX-1). Provider
   * hooks reach daemon internals ONLY through this context, so they never re-implement the shared
   * skeleton and the coordinator stays the single owner of credential reads, freshness, and
   * rematerialization.
   */
  private bridgeRefreshCapabilities(): ConnectedServiceBridgeRefreshCapabilities {
    return {
      now: () => this.params.now(),
      readCredentialSource: (binding) => readCredentialForRefresh({
        api: this.params.api,
        credentials: this.params.credentials,
        binding,
      }),
      isOauthSourceStillValid: (source) => this.isOauthSourceStillValidForBridge(source),
      resolveSourceExpiresAt: (source) => this.resolveExpiresAtForSource(source),
      rematerializeTargets: (binding) => this.rematerializeTargetsForBinding(binding),
      activeServerDir: this.params.activeServerDir,
      baseDir: this.params.baseDir,
      accountSettings: this.params.accountSettingsProvider?.() ?? null,
      processEnv: this.params.processEnv ?? process.env,
    };
  }

  /** Resolve the authoritative expiry for a credential source (sealed metadata wins over the record). */
  private resolveExpiresAtForSource(source: ConnectedServiceCredentialSource): number | null {
    if (source.mode === 'plain') return source.record.expiresAt ?? null;
    return source.metadata.expiresAt ?? source.record.expiresAt ?? null;
  }

  /**
   * True when the source is an OAuth credential whose access token is NOT within the refresh window of
   * expiry. Mirrors the `force:false` not-needed gate in `refreshOauthBindingUnserialized` so the
   * bridge's "return current" path matches the proactive refresher's notion of "still valid".
   */
  private isOauthSourceStillValidForBridge(source: ConnectedServiceCredentialSource): boolean {
    if (source.record.kind !== 'oauth') return false;
    if (!source.record.oauth.accessToken.trim()) return false;
    const expiresAt = this.resolveExpiresAtForSource(source);
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
    return expiresAt - this.params.now() > this.params.refreshWindowMs;
  }

  /**
   * The single bridge-authz choke point (R3-3 / R3-6). An access-token bridge is authorized iff the
   * caller's PROVEN identity maps to a live runtime target bound to `serviceId` right now — and the
   * returned selection is that target's CURRENT binding (current active profile + current group
   * generation), NEVER the caller's captured snapshot. Caller-supplied selection/generation is not
   * trusted for identity: it cannot authorize a refresh nor decide which credential is rotated.
   *
   * Two identity kinds are accepted, resolved against the SAME registry owner:
   * - `sessionId`: a per-session provider process (e.g. the Claude SDK callback). A no-restart pool
   *   swap bumps the registry generation; the daemon resolves the current one, so a callback captured
   *   at an older generation still authorizes and refreshes the current profile (R3-3).
   * - `brokerSelectionIdentity`: a provider whose managed server is SHARED across sessions (OpenCode /
   *   Pi). The broker cannot present a per-session id, so it presents its stable selection identity;
   *   the daemon matches a live target carrying that identity (R3-6).
   */
  private resolveAuthorizedBridgeSelectionForBridge(input: Readonly<{
    sessionId?: string | null;
    brokerSelectionIdentity?: string | null;
    serviceId: ConnectedServiceId;
  }>): ConnectedServiceChildSelection {
    const target = this.resolveBridgeRuntimeTargetForIdentity(input);
    const selection = target
      ? resolveCurrentBridgeSelectionForTarget(target, input.serviceId)
      : null;
    if (!selection) {
      throw new ConnectedServiceBridgeSelectionAuthorizationError();
    }
    return selection;
  }

  private resolveBridgeRuntimeTargetForIdentity(input: Readonly<{
    sessionId?: string | null;
    brokerSelectionIdentity?: string | null;
  }>): ReturnType<ConnectedServiceRuntimeRegistry['getBySessionId']> {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    const bySession = sessionId ? this.runtimeRegistry.getBySessionId(sessionId) : null;
    if (bySession) return bySession;
    const brokerSelectionIdentity = typeof input.brokerSelectionIdentity === 'string'
      ? input.brokerSelectionIdentity.trim()
      : '';
    return brokerSelectionIdentity
      ? this.runtimeRegistry.getByBrokerSelectionIdentity(brokerSelectionIdentity)
      : null;
  }

  async refreshConnectedServiceCredentialForQuota(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force: boolean;
  }>): Promise<ConnectedServiceQuotaCredentialRefreshOutcome> {
    const result = await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: input.force, reason: 'quota_bridge' },
    );
    // Carry the reconnect-required verdict across the quota boundary: a refresh that failed
    // permanently (or was blocked by an existing needs_reauth latch) must not be reported as an
    // opaque `null` — the quota coordinator would otherwise overwrite the just-persisted
    // needs_reauth health with a retryable status and keep probing a dead account forever
    // (codex4 refresh_token_invalidated retry storm, 2026-07-09).
    const reauthRequired = result.status === 'blocked_by_credential_health'
      || (
        result.status === 'refresh_failed'
        && isReauthRequiredFailure(result.diagnostic.category ?? 'unknown')
      );
    return {
      record: result.status === 'refreshed' ? result.credential : null,
      reauthRequired,
    };
  }

  async refreshConnectedServiceCredentialForSpawnPreflight(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force?: boolean;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    return await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: input.force === true, reason: 'spawn_preflight' },
    );
  }

  async refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sessionId?: string | null;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    const binding = { serviceId: input.serviceId, profileId: input.profileId } satisfies BoundProfile;
    const result = await this.refreshOauthBinding(
      binding,
      this.params.now(),
      { force: true, reason: 'runtime_auth_failure' },
    );
    if (result.status !== 'refreshed') return result;

    const rematerialization = await this.rematerializeTargetsForBindingAfterRefresh(binding);
    const targetFailures = resolveRuntimeAuthRematerializationFailures({
      result: rematerialization,
      sessionId: input.sessionId ?? null,
    });
    if (targetFailures.length > 0) {
      return buildMaterializationFailureRefreshResult({
        sourceResult: result,
        failure: targetFailures[0]!,
        now: this.params.now(),
        refreshWindowMs: this.params.refreshWindowMs,
      });
    }

    if (!wasRuntimeAuthSessionRematerialized({ result: rematerialization, sessionId: input.sessionId ?? null })) {
      return await this.finalizeRefreshResult(binding, buildMissingRuntimeAuthTargetRefreshResult({
        binding,
        sourceResult: result,
        now: this.params.now(),
        refreshWindowMs: this.params.refreshWindowMs,
      }));
    }
    if (rematerialization.rematerializedTargets.length > 0) {
      await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets);
    }
    return result;
  }

  async handleExternalCredentialUpdate(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<void> {
    const profileId = String(input.profileId ?? '').trim();
    if (!profileId) return;
    const binding = { serviceId: input.serviceId, profileId } satisfies BoundProfile;
    const affectedTargets = await this.rematerializeTargetsForBinding(binding);
    if (affectedTargets.length === 0) return;
    await this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'reconnect_propagation',
    });
  }

  private async distributeRefreshedBinding(binding: BoundProfile): Promise<RematerializedTargetsResult> {
    const rematerialization = await this.rematerializeTargetsForBindingAfterRefresh(binding);
    if (rematerialization.rematerializedTargets.length > 0) {
      await this.notifyAuthUpdatedForRefreshedBinding(binding, rematerialization.rematerializedTargets);
    }
    return rematerialization;
  }

  private async maybeRefreshBinding(binding: BoundProfile, now: number): Promise<void> {
    const result = await this.refreshOauthBinding(binding, now, { force: false, reason: 'scheduled' });
    if (result.status === 'refresh_failed') {
      throw new ConnectedServiceCredentialRefreshError(result.diagnostic);
    }
    if (result.status === 'not_needed' && await this.hasStaleMaterializedHomeForBinding(binding, result, now)) {
      await this.distributeRefreshedBinding(binding);
    }
    // A 'refreshed' result already distributed BY CONSTRUCTION on the completion path (RR-1).
  }

  private async hasStaleMaterializedHomeForBinding(
    binding: BoundProfile,
    result: ConnectedServiceCredentialRefreshResult,
    now: number,
  ): Promise<boolean> {
    const targets = this.runtimeRegistry.listRefreshTargets();
    const agentIds = new Set(targets.map((target) => target.agentId));
    if (agentIds.size === 0) return false;

    const fingerprintCache = new Map<string, string | null>();
    fingerprintCache.set(
      binding.profileId,
      result.credential?.kind === 'oauth'
        ? computeConnectedServiceAccessTokenFingerprint(result.credential.oauth.accessToken)
        : null,
    );
    const stalenessInput = {
      binding,
      targets,
      activeServerDir: this.params.activeServerDir,
      processEnv: this.params.processEnv ?? process.env,
      now,
      refreshWindowMs: this.params.refreshWindowMs,
      resolveCanonicalGroupActiveProfileId: async (input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) =>
        (await this.resolveCanonicalGroupStateForRefresh(input, now))?.activeProfileId ?? null,
      resolveStoreAccessTokenFingerprintForProfile: async (profileId: string) => {
        if (fingerprintCache.has(profileId)) return fingerprintCache.get(profileId) ?? null;
        let fingerprint: string | null = null;
        try {
          const source = await readCredentialForRefresh({
            api: this.params.api,
            credentials: this.params.credentials,
            binding: { serviceId: binding.serviceId, profileId },
          });
          fingerprint = source?.record.kind === 'oauth'
            ? computeConnectedServiceAccessTokenFingerprint(source.record.oauth.accessToken)
            : null;
        } catch {
          fingerprint = null;
        }
        fingerprintCache.set(profileId, fingerprint);
        return fingerprint;
      },
    };

    // RR-9: ask each live provider (via its lifecycle descriptor) whether its materialized home is
    // stale for this binding — no provider-specific import in the shared coordinator.
    const resolveDescriptor = this.params.resolveLifecycleDescriptor
      ?? resolveConnectedServiceCredentialLifecycleDescriptor;
    for (const agentId of agentIds) {
      const descriptor = await resolveDescriptor(agentId);
      const hasStale = descriptor.materializedHomeMaintenance?.hasStaleMaterializedHomeForBinding;
      if (!hasStale) continue;
      if (!(descriptor.serviceIds as readonly string[]).includes(binding.serviceId)) continue;
      if (await hasStale(stalenessInput)) return true;
    }
    return false;
  }

  /**
   * Reads the CANONICAL current state of an auth group (server truth). The refresh corridor must
   * never trust a target's spawn-time selection snapshot for SHARED group-home identity: sessions
   * spawned at different generations carry divergent snapshots, and snapshot-based freshness checks
   * or rewrites make them fight over the one shared home (live incident 2026-07-08: alternating
   * cross-account clobbers of the pool home plus a per-refresh-cycle restart loop).
   */
  private async resolveCanonicalGroupStateForRefresh(
    input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
    now: number,
  ): Promise<Readonly<{ activeProfileId: string | null; generation: number }> | null> {
    const key = `${input.serviceId}::${input.groupId}`;
    const cached = this.canonicalGroupStateCache.get(key);
    if (cached && now - cached.atMs < 15_000) return cached.group;
    let group: Readonly<{ activeProfileId: string | null; generation: number }> | null = null;
    const reader = this.params.api.getConnectedServiceAuthGroup;
    if (typeof reader === 'function') {
      try {
        const value = await reader.call(this.params.api, {
          serviceId: input.serviceId,
          groupId: input.groupId,
        });
        group = value
          ? {
              activeProfileId: typeof value.activeProfileId === 'string' && value.activeProfileId.trim().length > 0
                ? value.activeProfileId
                : null,
              generation: value.generation,
            }
          : null;
      } catch {
        group = null;
      }
    }
    this.canonicalGroupStateCache.set(key, { atMs: now, group });
    return group;
  }

  private shouldDeferCredentialHealthReprobe(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): boolean {
    if (!canReprobeCredentialHealth(options.reason, options)) return true;
    const state = this.credentialHealthReprobeState.get(bindingKey(binding));
    return Boolean(state && now < state.nextProbeAt);
  }

  private resetCredentialHealthReprobe(binding: BoundProfile): void {
    this.credentialHealthReprobeState.delete(bindingKey(binding));
  }

  private armCredentialHealthReprobeBackoff(binding: BoundProfile, now: number): void {
    const key = bindingKey(binding);
    const previous = this.credentialHealthReprobeState.get(key);
    const failureCount = (previous?.failureCount ?? 0) + 1;
    this.credentialHealthReprobeState.set(key, {
      failureCount,
      nextProbeAt: now + credentialHealthReprobeDelayMs(failureCount - 1),
    });
  }

  private async refreshOauthBinding(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    // Coalesce + serialize per `{serviceId, profileId}` binding (NOT split on `force`). A rotation
    // consumes the refresh token server-side, so two concurrent refreshes for one binding could each
    // present the same record and mint a superseded (401-bound) token. Any caller that arrives while a
    // refresh is in flight awaits it; a forced caller adopts that result when it rotated, otherwise it
    // runs its own refresh chained strictly after (never concurrently) so it reads the freshly persisted
    // record.
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshes.get(key);
    if (existing) {
      // A rejecting in-flight refresh represents an attempt that re-running concurrently would not
      // improve; every joiner adopts the same rejection rather than firing a duplicate refresh.
      const observed = await existing;
      if (inFlightResultSatisfiesCaller(observed, options)) {
        return observed;
      }
      // Forced caller behind a non-rotating `not_needed`: run a fresh refresh, serialized after it.
    }

    const previous = this.inFlightRefreshes.get(key);
    const promise = (async () => {
      if (previous) {
        // Serialize behind any refresh already running for this binding before reading/rotating so a
        // chained refresh reads the freshly persisted (rotated) record instead of racing it.
        await previous.catch(() => undefined);
      }
      return await this.finalizeRefreshResult(
        binding,
        await this.refreshOauthBindingUnserialized(binding, now, options),
      );
    })();
    this.inFlightRefreshes.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightRefreshes.get(key) === promise) {
        this.inFlightRefreshes.delete(key);
      }
    }
  }

  private async finalizeRefreshResult(
    binding: BoundProfile,
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    if (result.status === 'refreshed') {
      this.resetCredentialHealthReprobe({
        serviceId: result.diagnostic.serviceId,
        profileId: result.diagnostic.profileId,
      });
      // RR-1: rotate+distribute is ONE transaction by construction. Every rotation funnels through
      // this single completion path (the OAuth leaf has exactly one caller), so no entry point —
      // scheduled, bridge, runtime-auth, quota probe, or spawn preflight — can mint a fresh token
      // and leave materialized targets (group siblings included) holding the superseded one.
      // Reentrancy guard: a distribution-triggered nested refresh (the rematerialization preflight
      // callback) must not recurse into another distribution.
      const distributionKey = bindingKey(binding);
      if (!this.distributingRefreshedBindings.has(distributionKey)) {
        this.distributingRefreshedBindings.add(distributionKey);
        try {
          await this.distributeRefreshedBinding(binding);
        } finally {
          this.distributingRefreshedBindings.delete(distributionKey);
        }
      }
    } else if (
      result.status === 'refresh_failed'
      && isReauthRequiredFailure(result.diagnostic.category ?? 'unknown')
    ) {
      this.armCredentialHealthReprobeBackoff({
        serviceId: result.diagnostic.serviceId,
        profileId: result.diagnostic.profileId,
      }, this.params.now());
    }
    this.logRefreshDiagnostic(result.diagnostic);
    await persistCredentialHealthForRefreshResult({
      api: this.params.api,
      result,
      now: this.params.now(),
    });
    await this.notifyCredentialHealthForRefreshResult(result);
    return result;
  }

  private logRefreshDiagnostic(diagnostic: ConnectedServiceCredentialRefreshDiagnostic): void {
    if (this.params.logRefreshDiagnostic) {
      this.params.logRefreshDiagnostic(diagnostic);
      return;
    }
    logger.debug('[DAEMON RUN] Connected-service credential refresh diagnostic', diagnostic);
  }

  /**
   * R3-M1: the bridge's adopt/return-current (non-rotating) short-circuits used to be INVISIBLE —
   * the "invisible refresh" visibility gap. Emit one structured diagnostic so an operator can see
   * that a bridge served the current token without rotating. Names/fingerprints ONLY — a token value
   * is never logged (only a safe salted fingerprint of the served access token).
   */
  private logBridgeCurrentTokenAdoptionDiagnostic(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    reason: 'setup_token' | 'adopted_current' | 'not_needed';
    accessToken: string;
  }>): void {
    logger.info('[DAEMON RUN] Connected-service bridge served current access token (no rotation)', {
      serviceId: input.serviceId,
      profileId: input.profileId,
      reason: input.reason,
      accessTokenFingerprint: computeConnectedServiceAccessTokenFingerprint(input.accessToken),
    });
  }

  private async notifyCredentialHealthForRefreshResult(
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<void> {
    if (result.status !== 'refresh_failed') return;
    const notify = this.params.onCredentialHealthNotification;
    if (!notify) return;

    const diagnostic = result.diagnostic;
    const binding = {
      serviceId: diagnostic.serviceId,
      profileId: diagnostic.profileId,
    };
    const category = diagnostic.category ?? 'unknown';
    const healthStatus: ConnectedServiceCredentialHealthNotificationStatus = isReauthRequiredFailure(category)
      ? 'reconnect_required'
      : 'refresh_failed_retryable';
    const affectedTargets = this.resolveNotificationTargetsForBinding(binding);

    try {
      await notify({
        diagnostic,
        healthStatus,
        affectedTargets,
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to dispatch connected-service credential health notification', {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
  }

  private resolveNotificationTargetsForBinding(
    binding: BoundProfile,
  ): ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget> {
    return this.runtimeRegistry.listRefreshTargets()
      .filter((target) => target.bindings.some((b) => b.serviceId === binding.serviceId && b.profileId === binding.profileId))
      .map((target) => ({
        pid: target.pid,
        agentId: target.agentId,
        sessionId: target.sessionId ?? target.materializationKey,
      }));
  }

  private async refreshOauthBindingUnserialized(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    const source = await readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    if (!source) {
      return {
        status: 'credential_missing',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'credential_missing',
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const record = source.record;
    if (record.kind !== 'oauth') {
      return {
        status: 'not_oauth',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'not_oauth',
          expiresAt: record.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const expiresAt = source.mode === 'plain' ? record.expiresAt : source.metadata.expiresAt ?? record.expiresAt;
    let isCredentialHealthReprobe = false;
    if (
      shouldBlockRefreshForCredentialHealth(options.reason)
      && isReconnectRequiredProfileStatus(await readCredentialHealthStatusForRefresh({
        api: this.params.api,
        binding,
      }))
    ) {
      if (this.shouldDeferCredentialHealthReprobe(binding, now, options)) {
        return {
          status: 'blocked_by_credential_health',
          credential: null,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'blocked_by_credential_health',
            expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
      isCredentialHealthReprobe = true;
    }
    if (!options.force && !isCredentialHealthReprobe) {
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
        return {
          status: 'not_needed',
          credential: record,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'not_needed',
            expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
      if (expiresAt - now > this.params.refreshWindowMs) {
        return {
          status: 'not_needed',
          credential: record,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'not_needed',
            expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
    }

    const machineId = this.params.machineIdProvider();
    if (!machineId) {
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const ownerId = this.params.ownerIdProvider?.()?.trim();
    const lease = await this.params.api.acquireConnectedServiceRefreshLease({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      machineId,
      ...(ownerId ? { ownerId } : {}),
      leaseMs: this.params.refreshLeaseMs,
    });
    if (!lease.acquired) {
      const observed = await this.waitForContendedRefresh(binding, source, lease.leaseUntil, now, options);
      if (observed) return observed;
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const refreshRecord = record;

    if (!refreshRecord.oauth.refreshToken.trim()) {
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'missing_refresh_token',
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    let refreshed;
    try {
      refreshed = await refreshConnectedAccountOauthTokens({
        serviceId: binding.serviceId,
        refreshToken: refreshRecord.oauth.refreshToken,
        now,
      });
    } catch (error) {
      const refreshError = error instanceof ConnectedServiceOauthRefreshError ? error : null;
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: refreshError?.category ?? 'unknown',
          providerStatus: refreshError?.status,
          providerErrorCode: refreshError?.providerErrorCode,
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    const next = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken: refreshed.idToken,
      scope: refreshed.scope,
      tokenType: refreshed.tokenType,
      providerAccountId: refreshed.providerAccountId,
      providerEmail: refreshed.providerEmail,
      expiresAt: refreshed.expiresAt,
    };

    const updated = buildUpdatedOauthRecord({
      now,
      record: refreshRecord,
      next,
    });

    await persistRefreshedCredential({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
      source,
      updated,
    });
    await clearRegisteredGroupMemberRuntimeStateWithPositiveEvidence({
      api: this.params.api,
      runtimeRegistry: this.runtimeRegistry,
      binding,
      evidence: { kind: 'credential_refresh', observedAtMs: now },
    });
    return {
      status: 'refreshed',
      credential: updated,
      diagnostic: buildRefreshDiagnostic({
        binding,
        reason: options.reason,
        status: 'refreshed',
        expiresAt: updated.expiresAt,
        now,
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async waitForContendedRefresh(
    binding: BoundProfile,
    source: ConnectedServiceCredentialSource,
    leaseUntil: number,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult | null> {
    if (options.reason === 'scheduled') return null;
    if (source.record.kind !== 'oauth') return null;
    const waitMaxMs = typeof this.params.leaseContentionWaitMaxMs === 'number'
      && Number.isFinite(this.params.leaseContentionWaitMaxMs)
      ? Math.max(0, Math.trunc(this.params.leaseContentionWaitMaxMs))
      : 0;
    if (waitMaxMs <= 0) return null;

    const currentNow = this.params.now();
    const waitMs = Math.min(waitMaxMs, Math.max(0, Math.trunc(leaseUntil - currentNow)));
    if (waitMs > 0) {
      await (this.params.sleepMs ?? defaultSleepMs)(waitMs);
    }

    const observedSource = await readCredentialForRefresh({
      api: this.params.api,
      credentials: this.params.credentials,
      binding,
    });
    if (!observedSource || observedSource.record.kind !== 'oauth') return null;
    if (!hasObservedOauthCredentialChanged(source.record, observedSource.record)) return null;

    const observedExpiresAt = observedSource.mode === 'plain'
      ? observedSource.record.expiresAt
      : observedSource.metadata.expiresAt ?? observedSource.record.expiresAt;
    return {
      status: 'refreshed',
      credential: observedSource.record,
      diagnostic: buildRefreshDiagnostic({
        binding,
        reason: options.reason,
        status: 'refreshed',
        expiresAt: observedExpiresAt,
        now: this.params.now(),
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async rematerializeTargetsForBinding(binding: BoundProfile): Promise<ReadonlyArray<SpawnTarget>> {
    return (await this.rematerializeTargetsForBindingDetailed(binding)).rematerializedTargets;
  }

  private async rematerializeTargetsForBindingAfterRefresh(binding: BoundProfile): Promise<RematerializedTargetsResult> {
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshRematerializations.get(key);
    if (existing) return await existing;

    const promise = this.rematerializeTargetsForBindingDetailed(binding);
    this.inFlightRefreshRematerializations.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightRefreshRematerializations.get(key) === promise) {
        this.inFlightRefreshRematerializations.delete(key);
      }
    }
  }

  private async notifyAuthUpdatedForRefreshedBinding(
    binding: BoundProfile,
    affectedTargets: ReadonlyArray<SpawnTarget>,
  ): Promise<void> {
    if (affectedTargets.length === 0) return;
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshAuthUpdatedNotifications.get(key);
    if (existing) {
      await existing;
      return;
    }

    const promise = Promise.resolve(this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'refresh_triggered_restart',
    }));
    this.inFlightRefreshAuthUpdatedNotifications.set(key, promise);
    try {
      await promise;
    } finally {
      queueMicrotask(() => {
        if (this.inFlightRefreshAuthUpdatedNotifications.get(key) === promise) {
          this.inFlightRefreshAuthUpdatedNotifications.delete(key);
        }
      });
    }
  }

  private async rematerializeTargetsForBindingDetailed(binding: BoundProfile): Promise<RematerializedTargetsResult> {
    const affected = this.runtimeRegistry.listRefreshTargets().filter((target) =>
      target.bindings.some((b) => b.serviceId === binding.serviceId && b.profileId === binding.profileId),
    );
    const rematerialized: SpawnTarget[] = [];
    const failed: RematerializedTargetFailure[] = [];
    for (const rawTarget of affected) {
      // SHARED group homes are owned by the group's CURRENT canonical active profile. Rewrite them
      // from canonical state only — a spawn-time selection snapshot may be stale (deferred switch,
      // respawn with old env), and snapshot-based rewrites make concurrent sessions clobber each
      // other's account token in the shared home. Fail closed when canonical state is unreadable.
      const target = await canonicalizeTargetSelectionsForRematerialization({
        target: rawTarget,
        resolveCanonicalGroupState: async (input) =>
          await this.resolveCanonicalGroupStateForRefresh(input, this.params.now()),
      });
      if (!target) {
        logger.warn('[DAEMON RUN] Skipping connected-service rematerialization; canonical group state unavailable', {
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          agentId: rawTarget.agentId,
          pid: rawTarget.pid,
        });
        continue;
      }
      const records = await resolveConnectedServiceCredentials({
        credentials: this.params.credentials,
        api: this.params.api,
        bindings: target.bindings,
      });
      const materialized = await materializeConnectedServicesForSpawn({
        agentId: target.agentId,
        materializationKey: target.materializationKey,
        // RD-MAT-6: without the identity the root resolver sha256-hashes the key into an orphan
        // root the session never reads; thread the identity so refresh-driven rematerialization
        // applies fresh credentials to the LIVE `<baseDir>/<csm_*>/<agentId>` root.
        connectedServiceMaterializationIdentityV1: resolveSpawnTargetMaterializationIdentity(target),
        // RD-MAT-6: without the session directory, Claude workspace-trust projection falls back to
        // the daemon's cwd instead of the session's project directory.
        sessionDirectory: target.sessionDirectory,
        activeServerDir: this.params.activeServerDir,
        baseDir: this.params.baseDir,
        recordsByServiceId: records,
        accountSettings: this.params.accountSettingsProvider?.() ?? null,
        processEnv: this.params.processEnv ?? process.env,
        ...(target.selectionsByServiceId.size > 0
          ? { selectionsByServiceId: buildResolvedSelectionsForTarget(target, records) }
          : {}),
      });
      const blockingDiagnostics = collectBlockingConnectedServicesMaterializationDiagnostics(materialized?.diagnostics);
      if (blockingDiagnostics.length > 0) {
        const primaryDiagnostic = blockingDiagnostics[0]!;
        const affectedBinding = target.bindings.find((candidate) => candidate.serviceId === primaryDiagnostic.serviceId)
          ?? target.bindings.find((candidate) => candidate.serviceId === binding.serviceId)
          ?? binding;
        await persistCredentialHealthForMaterializationFailure({
          api: this.params.api,
          binding: affectedBinding,
          diagnostic: primaryDiagnostic,
          now: this.params.now(),
        });
        failed.push({
          target,
          binding: affectedBinding,
          diagnostic: primaryDiagnostic,
        });
        logger.warn('[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart', {
          serviceId: affectedBinding.serviceId,
          profileId: affectedBinding.profileId,
          agentId: target.agentId,
          materializationCode: primaryDiagnostic.code,
          reason: primaryDiagnostic.reason ?? null,
        });
        continue;
      }
      rematerialized.push(target);
    }
    return {
      affectedTargets: affected,
      rematerializedTargets: rematerialized,
      failedTargets: failed,
    };
  }
}

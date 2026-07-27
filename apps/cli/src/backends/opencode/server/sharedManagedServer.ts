import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { configuration } from '@/configuration';
import { resolveOpenCodeCliLaunchSpec, type ProviderCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { logger } from '@/ui/logger';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

import {
  getOpenCodeServerProcessInfoBestEffort,
  isOpenCodeServerPidAlive,
  type OpenCodeServerProcessInfo,
} from './openCodeServerProcessState';
import { withOpenCodeServerFileLock } from './openCodeServerFileLock';
import { startManagedOpenCodeServer } from './openCodeManagedServer';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';
import {
  terminateManagedOpenCodeServerPidBestEffort,
  terminateManagedOpenCodeServerPidBestEffortWithOptions,
} from './terminateManagedOpenCodeServerPidBestEffort';

export type SharedManagedOpenCodeServerState = Readonly<{
  v?: 2;
  baseUrl: string;
  pid: number;
  startedAtMs: number;
  status?: 'starting' | 'ready' | 'failed';
  lastFailureAtMs?: number;
  launchEnvFingerprint?: string;
  ownerToken?: string;
  startTimeMs?: number;
  expectedCmdlineHash?: string;
  activeServerDir?: string;
  daemonInstanceId?: string;
  /** Non-secret activation nonce inherited by this exact managed OpenCode child generation. */
  brokerLoadNonce?: string;
  /**
   * Path to the durable per-server log file (see `managedServerLogs/`). Optional so older state
   * files and non-logging callers remain compatible. Diagnostics link old/new server logs across a
   * managed-server replacement.
   */
  logPath?: string;
}>;

type ManagedServerProcessInfo = OpenCodeServerProcessInfo;
type ManagedServerLaunchSpec = ProviderCliLaunchSpec;

type ResolveDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  writeState: (state: SharedManagedOpenCodeServerState) => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  probeHealth: (baseUrl: string) => Promise<boolean>;
  getProcessInfo?: (pid: number) => Promise<ManagedServerProcessInfo | null>;
  resolveLaunchSpec?: () => ManagedServerLaunchSpec | null;
  killPid?: (pid: number) => Promise<boolean> | boolean;
  killPidWithDrain?: (pid: number, drainMs: number) => Promise<boolean> | boolean;
  currentLaunchFingerprint?: string | null;
  currentActiveServerDir?: string | null;
  currentDaemonInstanceId?: string | null;
  currentBrokerLoadNonceRequired?: boolean;
  generateOwnerToken?: () => string;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null> | number | null;
  startServer: (params?: {
    onSpawned?: (started: Readonly<{
      baseUrl: string;
      pid: number;
      logPath?: string;
      brokerLoadNonce?: string;
    }>) => void | Promise<void>;
  }) => Promise<{ baseUrl: string; pid: number; logPath?: string; brokerLoadNonce?: string }>;
  nowMs?: () => number;
}>;

type ReleaseForAuthSwitchDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  removeState: () => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  getProcessInfo: (pid: number) => Promise<ManagedServerProcessInfo | null>;
  readProcessStartTimeMs: (pid: number) => Promise<number | null> | number | null;
  killPid: (pid: number, drainMs: number) => Promise<boolean> | boolean;
  currentActiveServerDir: string;
  currentDaemonInstanceId: string;
  expectedOwnerToken: string;
  drainMs: number;
  trackedClaimCountForLaunchFingerprint?: () => Promise<number> | number;
  allowCurrentSessionClaim?: boolean;
  /**
   * Lane F prevention: returns whether the managed server's remaining claimant (the switching
   * session kept by `allowCurrentSessionClaim`) currently has an in-flight OpenCode turn. When it
   * does, the release is deferred (the server is left running, state intact) so the turn is never
   * torn down mid-stream — closing the OQ-2 sole-claimant mid-turn-kill window. The server is then
   * reaped at turn quiescence by the orphan-reap startup scan once no claim remains.
   */
  hasInFlightTurnForLaunchFingerprint?: () => Promise<boolean> | boolean;
}>;

type ReleaseForAuthSwitchResult = Readonly<{
  released: boolean;
  reason:
    | 'released'
    | 'state_missing'
    | 'state_untrusted'
    | 'owner_token_mismatch'
    | 'daemon_instance_mismatch'
    | 'active_server_dir_mismatch'
    | 'pid_dead'
    | 'process_identity_mismatch'
    | 'tracked_session_claimed'
    | 'in_flight_turn';
}>;

function hashCommandLine(rawCommandLine: string): string {
  return createHash('sha256').update(rawCommandLine).digest('hex');
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readPositiveInt(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function stateBelongsToCurrentDaemonOwner(
  state: SharedManagedOpenCodeServerState,
  deps: Pick<ResolveDeps, 'currentActiveServerDir' | 'currentDaemonInstanceId'>,
): boolean {
  if (state.v !== 2) return true;
  const currentDaemonInstanceId = readNonEmptyString(deps.currentDaemonInstanceId ?? null);
  const currentActiveServerDir = readNonEmptyString(deps.currentActiveServerDir ?? null);
  if (!currentDaemonInstanceId || !currentActiveServerDir) return true;
  return state.daemonInstanceId === currentDaemonInstanceId
    && state.activeServerDir === currentActiveServerDir;
}

export function resolveManagedOpenCodeDaemonOwnerIdFromState(
  state: unknown,
  fallbackActiveServerId: string,
): string {
  const source = typeof state === 'object' && state !== null
    ? state as Record<string, unknown>
    : null;
  const runtimeId = readNonEmptyString(source?.runtimeId);
  const pid = readPositiveInt(source?.pid);
  const startedAt = readPositiveInt(source?.startedAt);
  if (runtimeId && pid !== null && startedAt !== null) {
    return `${runtimeId}:${pid}:${startedAt}`;
  }
  return runtimeId ?? readNonEmptyString(fallbackActiveServerId) ?? 'cloud';
}

function readCurrentDaemonOwnerIdBestEffort(): string | null {
  try {
    return resolveManagedOpenCodeDaemonOwnerIdFromState(
      JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8')),
      configuration.activeServerId,
    );
  } catch {
    return null;
  }
}

function resolveCurrentManagedServerOwnerId(): string {
  return readCurrentDaemonOwnerIdBestEffort() ?? configuration.activeServerId;
}

function isTrustedManagedOpenCodeStateV2(state: SharedManagedOpenCodeServerState): boolean {
  return state.v === 2
    && Boolean(readNonEmptyString(state.ownerToken))
    && Boolean(readNonEmptyString(state.expectedCmdlineHash))
    && Boolean(readNonEmptyString(state.activeServerDir))
    && Boolean(readNonEmptyString(state.daemonInstanceId))
    && Boolean(readPositiveInt(state.startTimeMs));
}

function isCompatibleProcessStartTime(stateStartTimeMs: number, observedStartTimeMs: number): boolean {
  return Math.abs(stateStartTimeMs - observedStartTimeMs) <= 2_000;
}

type ManagedOpenCodeStartupScanStateDecision = Readonly<{
  action: 'keep' | 'drop';
  reason:
    | 'verified_live_state'
    | 'state_untrusted'
    | 'daemon_instance_mismatch'
    | 'active_server_dir_mismatch'
    | 'pid_dead'
    | 'process_identity_mismatch';
}>;

type ManagedOpenCodeStartupScanOrphanReapDecision = Readonly<{
  action: 'drop' | 'keep' | 'reap';
  reason:
    | ManagedOpenCodeStartupScanStateDecision['reason']
    | 'tracked_session_claimed'
    | 'tracked_claim_unknown'
    | 'no_tracked_claims';
}>;

type TrackedOpenCodeLaunchFingerprintClaims = Readonly<{
  countsByLaunchFingerprint: ReadonlyMap<string, number>;
  hasUnknownOpenCodeTrackedClaims: boolean;
  /**
   * Launch fingerprints for which at least one claiming OpenCode session currently has an in-flight
   * turn (per the daemon's connected-service turn deferral queue). Used by the auth-switch release
   * to defer killing a server whose sole claimant is still mid-turn (Lane F).
   */
  inFlightTurnLaunchFingerprints: ReadonlySet<string>;
}>;

/**
 * Best-effort resolver for the daemon-owned per-session in-flight-turn query. Returns `null` when
 * the daemon registry is unavailable (e.g. unit tests, non-daemon contexts). Mirrors the dynamic
 * import used for tracked session markers so `sharedManagedServer` stays free of a hard daemon
 * dependency.
 */
async function resolveOpenCodeConnectedServiceInFlightTurnQueryBestEffort(): Promise<
  ((sessionId: string) => boolean) | null
> {
  try {
    const registry = await import('@/daemon/connectedServices/sessionAuthSwitch/openCodeConnectedServiceInFlightTurnRegistry');
    const query = (registry as { isOpenCodeConnectedServiceTurnInFlight?: unknown })
      .isOpenCodeConnectedServiceTurnInFlight;
    return typeof query === 'function'
      ? (sessionId: string) => (query as (id: string) => boolean)(sessionId) === true
      : null;
  } catch {
    return null;
  }
}

export function decideManagedOpenCodeStartupScanStateAction(input: Readonly<{
  state: SharedManagedOpenCodeServerState;
  currentDaemonInstanceId: string;
  currentActiveServerDir: string;
  isPidAlive: boolean;
  processInfo: ManagedServerProcessInfo | null;
  observedStartTimeMs: number | null;
}>): ManagedOpenCodeStartupScanStateDecision {
  if (!isTrustedManagedOpenCodeStateV2(input.state)) {
    return { action: 'drop', reason: 'state_untrusted' };
  }
  if (input.state.daemonInstanceId !== input.currentDaemonInstanceId) {
    return { action: 'drop', reason: 'daemon_instance_mismatch' };
  }
  if (input.state.activeServerDir !== input.currentActiveServerDir) {
    return { action: 'drop', reason: 'active_server_dir_mismatch' };
  }
  if (!input.isPidAlive) {
    return { action: 'drop', reason: 'pid_dead' };
  }
  const identityMatches = Boolean(
    input.processInfo?.cmd
    && input.state.expectedCmdlineHash === hashCommandLine(input.processInfo.cmd)
    && Number.isFinite(input.observedStartTimeMs)
    && input.observedStartTimeMs !== null
    && isCompatibleProcessStartTime(input.state.startTimeMs as number, input.observedStartTimeMs),
  );
  if (!identityMatches) {
    return { action: 'drop', reason: 'process_identity_mismatch' };
  }
  return { action: 'keep', reason: 'verified_live_state' };
}

export function decideManagedOpenCodeStartupScanOrphanReapAction(input: Readonly<{
  stateDecision: ManagedOpenCodeStartupScanStateDecision;
  trackedClaimCount: number;
  hasUnknownOpenCodeTrackedClaims: boolean;
}>): ManagedOpenCodeStartupScanOrphanReapDecision {
  if (input.stateDecision.action === 'drop') {
    return { action: 'drop', reason: input.stateDecision.reason };
  }
  if (Number.isFinite(input.trackedClaimCount) && input.trackedClaimCount > 0) {
    return { action: 'keep', reason: 'tracked_session_claimed' };
  }
  if (input.hasUnknownOpenCodeTrackedClaims) {
    return { action: 'keep', reason: 'tracked_claim_unknown' };
  }
  return { action: 'reap', reason: 'no_tracked_claims' };
}

async function hasTrustedManagedOpenCodeStateIdentityForTermination(
  state: SharedManagedOpenCodeServerState,
  deps: Pick<ResolveDeps, 'currentActiveServerDir' | 'currentDaemonInstanceId' | 'readProcessStartTimeMs'>,
  processInfo: ManagedServerProcessInfo | null,
): Promise<boolean> {
  const currentDaemonInstanceId = readNonEmptyString(deps.currentDaemonInstanceId ?? null);
  const currentActiveServerDir = readNonEmptyString(deps.currentActiveServerDir ?? null);
  if (!currentDaemonInstanceId || !currentActiveServerDir) return false;

  const observedStartTimeMs = await Promise.resolve(
    deps.readProcessStartTimeMs
      ? deps.readProcessStartTimeMs(state.pid)
      : readProcessStartTimeMsBestEffort(state.pid),
  ).catch(() => null);
  const decision = decideManagedOpenCodeStartupScanStateAction({
    state,
    currentDaemonInstanceId,
    currentActiveServerDir,
    isPidAlive: true,
    processInfo,
    observedStartTimeMs,
  });
  return decision.action === 'keep';
}

function resolveManagedServersDirectory(): string {
  return join(configuration.happyHomeDir, 'opencode', 'managed-servers');
}

function resolveManagedServerStatePathByFingerprint(launchFingerprint: string): string {
  return join(resolveManagedServersDirectory(), `${launchFingerprint}.json`);
}

async function readProcessStartTimeMsBestEffort(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(Math.floor(pid))],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    )
      .trim();
    if (!output) return null;
    const line = output.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? '';
    if (!line) return null;
    const parsed = Date.parse(line);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function tryReadObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tryReadNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function tryReadLaunchFingerprintFromStatePath(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.endsWith('.json')) return null;
  const launchFingerprint = basename(trimmed, '.json').trim();
  return launchFingerprint.length > 0 ? launchFingerprint : null;
}

function tryReadLaunchFingerprintFromSessionMarker(marker: unknown): string | null {
  const markerRecord = tryReadObject(marker);
  if (!markerRecord) return null;
  const metadata = tryReadObject(markerRecord.metadata);
  const respawn = tryReadObject(markerRecord.respawn);
  const respawnEnv = tryReadObject(respawn?.environmentVariables);
  return (
    tryReadNonEmptyString(metadata?.opencodeManagedServerLaunchFingerprint)
    ?? tryReadNonEmptyString(metadata?.launchEnvFingerprint)
    ?? tryReadNonEmptyString(respawnEnv?.HAPPIER_OPENCODE_MANAGED_SERVER_LAUNCH_FINGERPRINT)
    ?? tryReadLaunchFingerprintFromStatePath(tryReadNonEmptyString(respawnEnv?.HAPPIER_OPENCODE_SERVER_STATE_PATH))
  );
}

function isOpenCodeTrackedSessionMarker(marker: unknown): boolean {
  const markerRecord = tryReadObject(marker);
  if (!markerRecord) return false;

  const metadata = tryReadObject(markerRecord.metadata);
  const respawn = tryReadObject(markerRecord.respawn);
  const backendTarget = tryReadObject(respawn?.backendTarget);
  const processCommand = tryReadNonEmptyString(markerRecord.processCommand);

  const metadataFlavor = tryReadNonEmptyString(metadata?.flavor)?.toLowerCase();
  if (metadataFlavor === 'opencode') return true;

  const metadataBackend = tryReadNonEmptyString(metadata?.backend)?.toLowerCase();
  if (metadataBackend === 'opencode') return true;

  const metadataAgentId = tryReadNonEmptyString(metadata?.agentId)?.toLowerCase();
  if (metadataAgentId === 'opencode') return true;

  if (
    backendTarget?.kind === 'builtInAgent'
    && tryReadNonEmptyString(backendTarget.agentId)?.toLowerCase() === 'opencode'
  ) {
    return true;
  }

  return Boolean(processCommand?.toLowerCase().includes('opencode'));
}

function isMarkerPidAliveBestEffort(pid: unknown): boolean {
  const numericPid = typeof pid === 'number' ? Math.floor(pid) : Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readTrackedOpenCodeLaunchFingerprintClaimsBestEffort(): Promise<TrackedOpenCodeLaunchFingerprintClaims> {
  const counts = new Map<string, number>();
  const inFlightTurnLaunchFingerprints = new Set<string>();
  let hasUnknownOpenCodeTrackedClaims = false;
  try {
    const daemonSessionRegistry = await import('@/daemon/sessionRegistry');
    const listSessionMarkers = (daemonSessionRegistry as { listSessionMarkers?: unknown }).listSessionMarkers;
    if (typeof listSessionMarkers !== 'function') {
      return {
        countsByLaunchFingerprint: counts,
        hasUnknownOpenCodeTrackedClaims: true,
        inFlightTurnLaunchFingerprints,
      };
    }
    const isTurnInFlight = await resolveOpenCodeConnectedServiceInFlightTurnQueryBestEffort();
    const markers = await Promise.resolve(
      (listSessionMarkers as () => Promise<readonly unknown[]> | readonly unknown[])(),
    ).catch(() => []);
    for (const marker of markers) {
      const markerRecord = tryReadObject(marker);
      if (!markerRecord || !isMarkerPidAliveBestEffort(markerRecord.pid)) continue;
      if (!isOpenCodeTrackedSessionMarker(markerRecord)) continue;
      const launchFingerprint = tryReadLaunchFingerprintFromSessionMarker(markerRecord);
      if (launchFingerprint) {
        const existing = counts.get(launchFingerprint) ?? 0;
        counts.set(launchFingerprint, existing + 1);
        const happySessionId = tryReadNonEmptyString(markerRecord.happySessionId);
        if (happySessionId && isTurnInFlight?.(happySessionId)) {
          inFlightTurnLaunchFingerprints.add(launchFingerprint);
        }
        continue;
      }
      hasUnknownOpenCodeTrackedClaims = true;
    }
  } catch {
    hasUnknownOpenCodeTrackedClaims = true;
  }
  return { countsByLaunchFingerprint: counts, hasUnknownOpenCodeTrackedClaims, inFlightTurnLaunchFingerprints };
}

function normalizeSharedManagedServerState(
  state: SharedManagedOpenCodeServerState,
): SharedManagedOpenCodeServerState {
  return {
    ...state,
    status: state.status === 'starting' || state.status === 'failed' ? state.status : 'ready',
    ...(typeof state.launchEnvFingerprint === 'string' && state.launchEnvFingerprint.trim()
      ? { launchEnvFingerprint: state.launchEnvFingerprint.trim() }
      : {}),
    ...(state.v === 2 ? { v: 2 as const } : {}),
    ...(typeof state.ownerToken === 'string' && state.ownerToken.trim()
      ? { ownerToken: state.ownerToken.trim() }
      : {}),
    ...(typeof state.expectedCmdlineHash === 'string' && state.expectedCmdlineHash.trim()
      ? { expectedCmdlineHash: state.expectedCmdlineHash.trim() }
      : {}),
    ...(typeof state.activeServerDir === 'string' && state.activeServerDir.trim()
      ? { activeServerDir: state.activeServerDir.trim() }
      : {}),
    ...(typeof state.daemonInstanceId === 'string' && state.daemonInstanceId.trim()
      ? { daemonInstanceId: state.daemonInstanceId.trim() }
      : {}),
    ...(typeof state.brokerLoadNonce === 'string' && state.brokerLoadNonce.trim()
      ? { brokerLoadNonce: state.brokerLoadNonce.trim() }
      : {}),
    ...(Number.isFinite(state.startTimeMs) && (state.startTimeMs ?? 0) > 0
      ? { startTimeMs: Math.floor(state.startTimeMs as number) }
      : {}),
    ...(typeof state.logPath === 'string' && state.logPath.trim()
      ? { logPath: state.logPath.trim() }
      : {}),
  };
}

export function isLoopbackManagedOpenCodeBaseUrl(rawBaseUrl: string): boolean {
  const value = rawBaseUrl.trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const port = Number.parseInt(url.port, 10);
    if (!Number.isFinite(port) || port <= 0) return false;

    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return true;
    if (host.startsWith('127.')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function resolveSharedManagedOpenCodeServerBaseUrl(
  deps: ResolveDeps,
): Promise<{ baseUrl: string; didStart: boolean; brokerLoadNonce?: string }> {
  return await deps.withLock(async () => {
    const rawState = await deps.readState();
    const state = rawState ? normalizeSharedManagedServerState(rawState) : null;
    const desiredLaunchFingerprint = typeof deps.currentLaunchFingerprint === 'string'
      ? deps.currentLaunchFingerprint.trim()
      : '';
    const launchFingerprintMismatch = Boolean(
      state
      && desiredLaunchFingerprint
      && state.launchEnvFingerprint !== desiredLaunchFingerprint,
    );
    if (state && deps.isPidAlive(state.pid) && isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      const ownerMismatch = !stateBelongsToCurrentDaemonOwner(state, deps);
      const brokerLoadNonceMissing = deps.currentBrokerLoadNonceRequired === true && !state.brokerLoadNonce;
      const healthy = ownerMismatch || launchFingerprintMismatch || brokerLoadNonceMissing
        ? false
        : await deps.probeHealth(state.baseUrl).catch(() => false);
      if (healthy) {
        if (state.status === 'failed') {
          await deps.writeState({
            baseUrl: state.baseUrl,
            pid: state.pid,
            startedAtMs: state.startedAtMs,
            status: 'ready',
            ...(state.launchEnvFingerprint ? { launchEnvFingerprint: state.launchEnvFingerprint } : {}),
            ...(state.brokerLoadNonce ? { brokerLoadNonce: state.brokerLoadNonce } : {}),
          });
        }
        return {
          baseUrl: state.baseUrl,
          didStart: false,
          ...(state.brokerLoadNonce ? { brokerLoadNonce: state.brokerLoadNonce } : {}),
        };
      }

      if (state.status === 'failed' || launchFingerprintMismatch) {
        if (deps.getProcessInfo && deps.killPid) {
          const info = await deps.getProcessInfo(state.pid).catch(() => null);
          if (await hasTrustedManagedOpenCodeStateIdentityForTermination(state, deps, info)) {
            await invokeKillPidBestEffort(deps.killPid, state.pid);
          }
        }
      } else if (!ownerMismatch && deps.getProcessInfo && deps.killPid) {
        const info = await deps.getProcessInfo(state.pid).catch(() => null);
        if (await hasTrustedManagedOpenCodeStateIdentityForTermination(state, deps, info)) {
          await invokeKillPidBestEffort(deps.killPid, state.pid);
        }
      }
    }

    const nowMs = deps.nowMs?.() ?? Date.now();
    const ownerToken = deps.generateOwnerToken?.() ?? randomUUID();
    const daemonInstanceId = readNonEmptyString(deps.currentDaemonInstanceId ?? null);
    const activeServerDir = readNonEmptyString(deps.currentActiveServerDir ?? null);
    let provisionalBaseUrl = '';
    let provisionalPid = -1;
    let provisionalStartTimeMs = nowMs;
    let provisionalExpectedCmdlineHash = '';
    let provisionalLogPath: string | undefined;
    let provisionalBrokerLoadNonce: string | undefined;

    const resolveOwnershipProof = async (pid: number): Promise<Readonly<{
      startTimeMs: number;
      expectedCmdlineHash: string;
    }>> => {
      const processInfo = deps.getProcessInfo
        ? await deps.getProcessInfo(pid).catch(() => null)
        : null;
      const expectedCmdlineHash = processInfo?.cmd ? hashCommandLine(processInfo.cmd) : '';
      const observedStartTimeMs = await Promise.resolve(
        deps.readProcessStartTimeMs
          ? deps.readProcessStartTimeMs(pid)
          : readProcessStartTimeMsBestEffort(pid),
      ).catch(() => null);
      return {
        startTimeMs: Number.isFinite(observedStartTimeMs) && (observedStartTimeMs ?? 0) > 0
          ? Math.floor(observedStartTimeMs as number)
          : nowMs,
        expectedCmdlineHash,
      };
    };

    try {
      const started = await deps.startServer({
        onSpawned: async (spawned) => {
          const ownershipProof = await resolveOwnershipProof(spawned.pid);
          provisionalBaseUrl = spawned.baseUrl;
          provisionalPid = spawned.pid;
          provisionalStartTimeMs = ownershipProof.startTimeMs;
          provisionalExpectedCmdlineHash = ownershipProof.expectedCmdlineHash;
          provisionalLogPath = readNonEmptyString(spawned.logPath) ?? undefined;
          provisionalBrokerLoadNonce = readNonEmptyString(spawned.brokerLoadNonce) ?? undefined;
          await deps.writeState({
            baseUrl: spawned.baseUrl,
            pid: spawned.pid,
            startedAtMs: nowMs,
            status: 'starting',
            ...(desiredLaunchFingerprint ? { launchEnvFingerprint: desiredLaunchFingerprint } : {}),
            ...(provisionalLogPath ? { logPath: provisionalLogPath } : {}),
            ...(provisionalBrokerLoadNonce ? { brokerLoadNonce: provisionalBrokerLoadNonce } : {}),
            ...(daemonInstanceId && activeServerDir
              ? {
                  v: 2 as const,
                  ownerToken,
                  startTimeMs: ownershipProof.startTimeMs,
                  expectedCmdlineHash: ownershipProof.expectedCmdlineHash,
                  activeServerDir,
                  daemonInstanceId,
                }
              : {}),
          });
        },
      });
      const ownershipProof = provisionalPid === started.pid
        ? {
            startTimeMs: provisionalStartTimeMs,
            expectedCmdlineHash: provisionalExpectedCmdlineHash,
          }
        : await resolveOwnershipProof(started.pid);
      const resolvedLogPath = readNonEmptyString(started.logPath) ?? provisionalLogPath;
      const resolvedBrokerLoadNonce = readNonEmptyString(started.brokerLoadNonce) ?? provisionalBrokerLoadNonce;
      const nextState: SharedManagedOpenCodeServerState = {
        baseUrl: started.baseUrl,
        pid: started.pid,
        startedAtMs: nowMs,
        status: 'ready',
        ...(desiredLaunchFingerprint ? { launchEnvFingerprint: desiredLaunchFingerprint } : {}),
        ...(resolvedLogPath ? { logPath: resolvedLogPath } : {}),
        ...(resolvedBrokerLoadNonce ? { brokerLoadNonce: resolvedBrokerLoadNonce } : {}),
        ...(daemonInstanceId && activeServerDir
          ? {
              v: 2 as const,
              ownerToken,
              startTimeMs: ownershipProof.startTimeMs,
              expectedCmdlineHash: ownershipProof.expectedCmdlineHash,
              activeServerDir,
              daemonInstanceId,
            }
          : {}),
      };
      await deps.writeState(nextState);
      return {
        baseUrl: started.baseUrl,
        didStart: true,
        ...(resolvedBrokerLoadNonce ? { brokerLoadNonce: resolvedBrokerLoadNonce } : {}),
      };
    } catch (error) {
      if (provisionalBaseUrl && provisionalPid > 0) {
        await deps.writeState({
          baseUrl: provisionalBaseUrl,
          pid: provisionalPid,
          startedAtMs: nowMs,
          status: 'failed',
          lastFailureAtMs: nowMs,
          ...(provisionalLogPath ? { logPath: provisionalLogPath } : {}),
          ...(provisionalBrokerLoadNonce ? { brokerLoadNonce: provisionalBrokerLoadNonce } : {}),
          ...(daemonInstanceId && activeServerDir
            ? {
                v: 2 as const,
                ownerToken,
                startTimeMs: provisionalStartTimeMs,
                expectedCmdlineHash: provisionalExpectedCmdlineHash,
                activeServerDir,
                daemonInstanceId,
              }
            : {}),
        });
      }
      throw error;
    }
  });
}

export function resolveSharedManagedOpenCodeServerStatePathForEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = expandHomeDirPath(
    typeof env.HAPPIER_OPENCODE_SERVER_STATE_PATH === 'string'
      ? env.HAPPIER_OPENCODE_SERVER_STATE_PATH.trim()
      : '',
    env,
  );
  if (raw) return raw;

  const xdgRootDir = resolveXdgRootDirFromEnv(env);
  const launchFingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
    baseEnv: env,
    xdgRootDir,
    isolateConfig: false,
  });
  return join(configuration.happyHomeDir, 'opencode', 'managed-servers', `${launchFingerprint}.json`);
}

function resolveStatePathFromEnv(): string {
  return resolveSharedManagedOpenCodeServerStatePathForEnv(process.env);
}

function resolveXdgRootDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = expandHomeDirPath(
    typeof env.HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR === 'string'
      ? env.HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR.trim()
      : '',
    env,
  );
  return raw.length > 0 ? raw : null;
}

function readManagedOpenCodeServerStateFromUnknown(parsed: unknown): SharedManagedOpenCodeServerState | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const baseUrl = typeof source.baseUrl === 'string' ? String(source.baseUrl).trim() : '';
  const pid = typeof source.pid === 'number' ? source.pid : Number(source.pid);
  const startedAtMs = typeof source.startedAtMs === 'number' ? source.startedAtMs : Number(source.startedAtMs);
  const statusRaw = typeof source.status === 'string' ? String(source.status).trim() : '';
  const lastFailureAtMsRaw = typeof source.lastFailureAtMs === 'number'
    ? source.lastFailureAtMs
    : Number(source.lastFailureAtMs);
  const launchEnvFingerprint = typeof source.launchEnvFingerprint === 'string'
    ? String(source.launchEnvFingerprint).trim()
    : '';
  const ownerToken = readNonEmptyString(source.ownerToken);
  const startTimeMs = readPositiveInt(source.startTimeMs);
  const expectedCmdlineHash = readNonEmptyString(source.expectedCmdlineHash);
  const activeServerDir = readNonEmptyString(source.activeServerDir);
  const daemonInstanceId = readNonEmptyString(source.daemonInstanceId);
  const logPath = readNonEmptyString(source.logPath);
  const brokerLoadNonce = readNonEmptyString(source.brokerLoadNonce);
  const stateVersion = source.v === 2 ? 2 as const : undefined;
  if (!baseUrl) return null;
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return {
    ...(stateVersion ? { v: stateVersion } : {}),
    baseUrl,
    pid: Math.floor(pid),
    startedAtMs: Math.floor(startedAtMs),
    ...(statusRaw === 'starting' || statusRaw === 'failed' || statusRaw === 'ready' ? { status: statusRaw } : {}),
    ...(Number.isFinite(lastFailureAtMsRaw) && lastFailureAtMsRaw > 0 ? { lastFailureAtMs: Math.floor(lastFailureAtMsRaw) } : {}),
    ...(launchEnvFingerprint ? { launchEnvFingerprint } : {}),
    ...(ownerToken ? { ownerToken } : {}),
    ...(startTimeMs ? { startTimeMs } : {}),
    ...(expectedCmdlineHash ? { expectedCmdlineHash } : {}),
    ...(activeServerDir ? { activeServerDir } : {}),
    ...(daemonInstanceId ? { daemonInstanceId } : {}),
    ...(logPath ? { logPath } : {}),
    ...(brokerLoadNonce ? { brokerLoadNonce } : {}),
  };
}

async function readStateFile(statePath: string): Promise<SharedManagedOpenCodeServerState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    return readManagedOpenCodeServerStateFromUnknown(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeStateFile(statePath: string, state: SharedManagedOpenCodeServerState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, statePath);
}

export async function readSharedManagedOpenCodeServerStateBestEffort(): Promise<SharedManagedOpenCodeServerState | null> {
  const statePath = resolveStatePathFromEnv();
  return await readStateFile(statePath);
}

export async function readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort(
  launchFingerprint: string,
): Promise<SharedManagedOpenCodeServerState | null> {
  const normalized = launchFingerprint.trim();
  if (!normalized) return null;
  return await readStateFile(resolveManagedServerStatePathByFingerprint(normalized));
}

export async function releaseForAuthSwitchFromState(
  deps: ReleaseForAuthSwitchDeps,
): Promise<ReleaseForAuthSwitchResult> {
  return await deps.withLock(async () => {
    const state = await deps.readState();
    if (!state) return { released: false, reason: 'state_missing' };

    if (!isTrustedManagedOpenCodeStateV2(state)) {
      await deps.removeState().catch(() => {});
      return { released: false, reason: 'state_untrusted' };
    }

    if (state.ownerToken !== deps.expectedOwnerToken) {
      await deps.removeState().catch(() => {});
      return { released: false, reason: 'owner_token_mismatch' };
    }

    if (state.daemonInstanceId !== deps.currentDaemonInstanceId) {
      await deps.removeState().catch(() => {});
      return { released: false, reason: 'daemon_instance_mismatch' };
    }

    if (state.activeServerDir !== deps.currentActiveServerDir) {
      await deps.removeState().catch(() => {});
      return { released: false, reason: 'active_server_dir_mismatch' };
    }

    if (!deps.isPidAlive(state.pid)) {
      await deps.removeState().catch(() => {});
      return { released: false, reason: 'pid_dead' };
    }

    const info = await deps.getProcessInfo(state.pid).catch(() => null);
    const observedStartTimeMs = await Promise.resolve(deps.readProcessStartTimeMs(state.pid)).catch(() => null);
    const identityMatches = Boolean(
      info?.cmd
      && state.expectedCmdlineHash === hashCommandLine(info.cmd)
      && Number.isFinite(observedStartTimeMs)
      && observedStartTimeMs !== null
      && isCompatibleProcessStartTime(state.startTimeMs as number, observedStartTimeMs),
    );
    if (!identityMatches) {
      await deps.removeState().catch(() => {});
      return { released: false, reason: 'process_identity_mismatch' };
    }

    if (deps.trackedClaimCountForLaunchFingerprint) {
      const claimCountRaw = await Promise.resolve(deps.trackedClaimCountForLaunchFingerprint()).catch(() => 0);
      const claimCount = Number.isFinite(claimCountRaw) && claimCountRaw > 0
        ? Math.floor(claimCountRaw)
        : 0;
      const remainingClaimCount = deps.allowCurrentSessionClaim
        ? Math.max(0, claimCount - 1)
        : claimCount;
      if (remainingClaimCount > 0) {
        return { released: false, reason: 'tracked_session_claimed' };
      }
    }

    // Lane F prevention (final gate before the kill): never tear down a managed server whose
    // remaining claimant — the switching session itself, kept by `allowCurrentSessionClaim` above —
    // still has an in-flight OpenCode turn. Multi-session claims are already protected by the claim
    // count; this closes the sole-claimant window (OQ-2) where the current session's claim is
    // subtracted to zero yet a turn is still streaming. Leave BOTH the process and the state file
    // intact: the turn finishes against the live server, which the orphan-reap startup scan then
    // releases once it has no remaining claims (release deferred to turn quiescence, never wedged).
    if (deps.hasInFlightTurnForLaunchFingerprint) {
      const hasInFlightTurn = await Promise.resolve(deps.hasInFlightTurnForLaunchFingerprint())
        .catch(() => false);
      if (hasInFlightTurn === true) {
        return { released: false, reason: 'in_flight_turn' };
      }
    }

    await Promise.resolve(deps.killPid(state.pid, deps.drainMs)).catch(() => false);
    await deps.removeState().catch(() => {});
    return { released: true, reason: 'released' };
  });
}

export async function releaseForAuthSwitch(
  previousLaunchFingerprint: string,
  expectedOwnerToken: string,
): Promise<ReleaseForAuthSwitchResult> {
  const normalizedFingerprint = previousLaunchFingerprint.trim();
  const normalizedOwnerToken = expectedOwnerToken.trim();
  if (!normalizedFingerprint || !normalizedOwnerToken) {
    return { released: false, reason: 'state_missing' };
  }
  const statePath = resolveManagedServerStatePathByFingerprint(normalizedFingerprint);
  const lockFile = `${statePath}.lock`;
  const drainMs = readPositiveIntEnv('HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS') ?? 10_000;
  const trackedClaims = await readTrackedOpenCodeLaunchFingerprintClaimsBestEffort();
  return await releaseForAuthSwitchFromState({
    withLock: async (fn) => await withOpenCodeServerFileLock(lockFile, fn),
    readState: async () => await readStateFile(statePath),
    removeState: async () => {
      await rm(statePath, { force: true }).catch(() => {});
    },
    isPidAlive: isOpenCodeServerPidAlive,
    getProcessInfo: async (pid) => await getProcessInfoBestEffort(pid),
    readProcessStartTimeMs: async (pid) => await readProcessStartTimeMsBestEffort(pid),
    killPid: async (pid, drainTimeoutMs) => {
      const killGraceMs = Math.max(250, Math.floor(drainTimeoutMs));
      return await terminateManagedOpenCodeServerPidBestEffortWithOptions(pid, {
        graceMs: killGraceMs,
      });
    },
    currentActiveServerDir: configuration.activeServerDir,
    currentDaemonInstanceId: resolveCurrentManagedServerOwnerId(),
    expectedOwnerToken: normalizedOwnerToken,
    drainMs,
    trackedClaimCountForLaunchFingerprint: () => {
      const explicitClaimCount = trackedClaims.countsByLaunchFingerprint.get(normalizedFingerprint) ?? 0;
      if (trackedClaims.hasUnknownOpenCodeTrackedClaims) {
        return Math.max(2, explicitClaimCount);
      }
      return explicitClaimCount;
    },
    allowCurrentSessionClaim: true,
    hasInFlightTurnForLaunchFingerprint: () =>
      trackedClaims.inFlightTurnLaunchFingerprints.has(normalizedFingerprint),
  });
}

export async function ensureSharedManagedOpenCodeServerBaseUrl(params: Readonly<{
  probeHealth: (baseUrl: string) => Promise<boolean>;
  requireBrokerLoadNonce?: boolean;
}>): Promise<string> {
  const statePath = resolveStatePathFromEnv();
  const lockFile = `${statePath}.lock`;
  const currentLaunchFingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
    baseEnv: process.env,
    xdgRootDir: resolveXdgRootDirFromEnv(),
    isolateConfig: false,
  });

  void (async () => {
    const managedServersDir = resolveManagedServersDirectory();
    const trackedClaims = await readTrackedOpenCodeLaunchFingerprintClaimsBestEffort();
    const drainMs = readPositiveIntEnv('HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS') ?? 10_000;
    let entries: readonly string[] = [];
    try {
      entries = (await readdir(managedServersDir))
        .filter((entry) => entry.endsWith('.json'));
    } catch {
      return;
    }
    for (const entry of entries) {
      const launchFingerprint = basename(entry, '.json').trim();
      if (!launchFingerprint || launchFingerprint === currentLaunchFingerprint) continue;
      const statePathByFingerprint = resolveManagedServerStatePathByFingerprint(launchFingerprint);
      const lockFileByFingerprint = `${statePathByFingerprint}.lock`;
      await withOpenCodeServerFileLock(lockFileByFingerprint, async () => {
        const state = await readStateFile(statePathByFingerprint);
        if (!state) {
          await rm(statePathByFingerprint, { force: true }).catch(() => {});
          return;
        }
        const pidAlive = isOpenCodeServerPidAlive(state.pid);
        const processInfo = pidAlive ? await getProcessInfoBestEffort(state.pid).catch(() => null) : null;
        const observedStartTimeMs = pidAlive
          ? await readProcessStartTimeMsBestEffort(state.pid).catch(() => null)
          : null;
        const decision = decideManagedOpenCodeStartupScanStateAction({
          state,
          currentDaemonInstanceId: resolveCurrentManagedServerOwnerId(),
          currentActiveServerDir: configuration.activeServerDir,
          isPidAlive: pidAlive,
          processInfo,
          observedStartTimeMs,
        });
        const reapDecision = decideManagedOpenCodeStartupScanOrphanReapAction({
          stateDecision: decision,
          trackedClaimCount: trackedClaims.countsByLaunchFingerprint.get(launchFingerprint) ?? 0,
          hasUnknownOpenCodeTrackedClaims: trackedClaims.hasUnknownOpenCodeTrackedClaims,
        });
        if (reapDecision.action === 'drop') {
          await rm(statePathByFingerprint, { force: true }).catch(() => {});
          return;
        }
        if (reapDecision.action === 'reap') {
          const didTerminate = await terminateManagedOpenCodeServerPidBestEffortWithOptions(state.pid, {
            graceMs: Math.max(250, Math.floor(drainMs)),
          }).catch(() => false);
          if (didTerminate) {
            await rm(statePathByFingerprint, { force: true }).catch(() => {});
          }
        }
      }).catch(() => {});
    }
  })().catch((error) => {
    logger.debug('[OpenCodeServer] managed-server startup scan failed (non-fatal)', error);
  });

  // By default, preserve the user's HOME/USERPROFILE and XDG config directory for OpenCode so the
  // managed server sees the same provider plugins and auth config as the user's normal OpenCode CLI.
  // Happier's stack home remains in HAPPIER_HOME_DIR for Happier state only; it is not an OpenCode
  // config home. The optional root below isolates only runtime data/state/cache unless explicitly
  // passed with isolateConfig by a test or future controlled flow.
  //
  // If you need to isolate OpenCode’s XDG dirs (e.g. multi-user shared hosts), set:
  // `HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR=/path`.
  const xdgRootDir = resolveXdgRootDirFromEnv();

  const resolved = await resolveSharedManagedOpenCodeServerBaseUrl({
    withLock: async (fn) => await withOpenCodeServerFileLock(lockFile, fn),
    readState: async () => await readStateFile(statePath),
    writeState: async (state) => await writeStateFile(statePath, state),
    isPidAlive: isOpenCodeServerPidAlive,
    probeHealth: params.probeHealth,
    getProcessInfo: async (pid) => await getProcessInfoBestEffort(pid),
    resolveLaunchSpec: resolveManagedOpenCodeLaunchSpecBestEffort,
    killPid: killPidBestEffort,
    currentLaunchFingerprint,
    currentActiveServerDir: configuration.activeServerDir,
    currentDaemonInstanceId: resolveCurrentManagedServerOwnerId(),
    currentBrokerLoadNonceRequired: params.requireBrokerLoadNonce === true,
    generateOwnerToken: () => randomUUID(),
    readProcessStartTimeMs: async (pid) => await readProcessStartTimeMsBestEffort(pid),
    startServer: async (startParams) => {
      const started = await startManagedOpenCodeServer({
        ...(xdgRootDir ? { xdgRootDir } : {}),
        ...(currentLaunchFingerprint ? { launchFingerprint: currentLaunchFingerprint } : {}),
        ...(startParams?.onSpawned ? { onSpawned: startParams.onSpawned } : {}),
      });
      return {
        baseUrl: started.baseUrl,
        pid: started.pid,
        logPath: started.logPath,
        ...(started.brokerLoadNonce ? { brokerLoadNonce: started.brokerLoadNonce } : {}),
      };
    },
  });

  return resolved.baseUrl;
}

type StopDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  removeState: () => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  probeHealth: (baseUrl: string) => Promise<boolean>;
  getProcessInfo: (pid: number) => Promise<ManagedServerProcessInfo | null>;
  resolveLaunchSpec?: () => ManagedServerLaunchSpec | null;
  killPid: (pid: number) => Promise<boolean> | boolean;
}>;

function looksLikeOpenCodeServe(info: ManagedServerProcessInfo | null): boolean {
  if (!info) return false;
  const cmd = info.cmd.toLowerCase();
  return cmd.includes('opencode') && cmd.includes('serve');
}

function splitCommandLine(raw: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function normalizeCommandToken(value: string): string {
  return value.trim().toLowerCase();
}

function matchesExecutableToken(
  actualToken: string | undefined,
  processName: string,
  expectedCommand: string,
): boolean {
  if (!actualToken) return false;
  const normalizedActual = normalizeCommandToken(actualToken);
  const normalizedExpected = normalizeCommandToken(expectedCommand);
  const actualBase = normalizeCommandToken(basename(actualToken));
  const expectedBase = normalizeCommandToken(basename(expectedCommand));
  const nameBase = normalizeCommandToken(basename(processName));
  return normalizedActual === normalizedExpected
    || actualBase === expectedBase
    || nameBase === expectedBase;
}

function parseManagedOpenCodeServerBaseUrl(baseUrl: string): Readonly<{ hostname: string; port: string }> | null {
  try {
    const url = new URL(baseUrl);
    if (!url.hostname || !url.port) return null;
    return { hostname: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

function looksLikeManagedOpenCodeServe(
  info: ManagedServerProcessInfo | null,
  baseUrl: string,
  resolveLaunchSpec?: () => ManagedServerLaunchSpec | null,
  options?: Readonly<{
    allowBroadHeuristicFallback?: boolean;
  }>,
): boolean {
  if (!info) return false;

  const allowBroadHeuristicFallback = options?.allowBroadHeuristicFallback !== false;

  const endpoint = parseManagedOpenCodeServerBaseUrl(baseUrl);
  const tokens = splitCommandLine(info.cmd);
  const normalizedTokens = tokens.map((token) => normalizeCommandToken(token));
  const expectedEndpointTokens = endpoint
    ? {
      hostname: endpoint.hostname,
      port: endpoint.port,
    }
    : null;
  const expectsServeTokens = expectedEndpointTokens
    ? normalizedTokens.includes('serve')
      && normalizedTokens.includes(`--hostname=${expectedEndpointTokens.hostname}`)
      && normalizedTokens.includes(`--port=${expectedEndpointTokens.port}`)
    : false;
  if (!expectedEndpointTokens || !expectsServeTokens) {
    return allowBroadHeuristicFallback ? looksLikeOpenCodeServe(info) : false;
  }

  const launchSpec = resolveLaunchSpec?.() ?? null;
  if (!launchSpec) {
    return allowBroadHeuristicFallback ? looksLikeOpenCodeServe(info) : false;
  }

  if (matchesExecutableToken(tokens[0], info.name, launchSpec.command)) {
    const expectedArgs = [
      ...launchSpec.args.map((arg) => normalizeCommandToken(arg)),
      'serve',
      `--hostname=${expectedEndpointTokens.hostname}`,
      `--port=${expectedEndpointTokens.port}`,
    ];
    const actualArgs = normalizedTokens.slice(1);
    if (expectedArgs.every((token, index) => actualArgs[index] === token)) {
      return true;
    }
  }

  return false;
}

function resolveManagedOpenCodeLaunchSpecBestEffort(): ManagedServerLaunchSpec | null {
  try {
    return resolveOpenCodeCliLaunchSpec();
  } catch {
    return null;
  }
}

async function getProcessInfoBestEffort(pid: number): Promise<ManagedServerProcessInfo | null> {
  return getOpenCodeServerProcessInfoBestEffort(pid);
}

async function invokeKillPidBestEffort(
  killPid: (pid: number) => Promise<boolean> | boolean,
  pid: number,
): Promise<boolean> {
  try {
    const didKill = await killPid(pid);
    return didKill !== false;
  } catch {
    return false;
  }
}

export async function stopSharedManagedOpenCodeServerFromState(
  deps: StopDeps,
): Promise<{ didKill: boolean }> {
  return await deps.withLock(async () => {
    const state = await deps.readState();
    if (!state) return { didKill: false };
    if (!deps.isPidAlive(state.pid)) {
      await deps.removeState().catch(() => {});
      return { didKill: false };
    }

    const healthy = isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)
      ? await deps.probeHealth(state.baseUrl).catch(() => false)
      : false;
    if (healthy) {
      const didKill = await invokeKillPidBestEffort(deps.killPid, state.pid);
      await deps.removeState().catch(() => {});
      return { didKill };
    }

    const info = await deps.getProcessInfo(state.pid).catch(() => null);
    if (looksLikeManagedOpenCodeServe(info, state.baseUrl, deps.resolveLaunchSpec, {
      allowBroadHeuristicFallback: false,
    })) {
      const didKill = await invokeKillPidBestEffort(deps.killPid, state.pid);
      await deps.removeState().catch(() => {});
      return { didKill };
    }

    await deps.removeState().catch(() => {});
    return { didKill: false };
  });
}

async function probeOpenCodeHealthBestEffort(baseUrl: string): Promise<boolean> {
  if (!isLoopbackManagedOpenCodeBaseUrl(baseUrl)) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    timer.unref?.();
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/global/health`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(timer);
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function killPidBestEffort(pid: number): Promise<boolean> {
  return await terminateManagedOpenCodeServerPidBestEffort(pid);
}

export async function stopSharedManagedOpenCodeServerFromEnvBestEffort(): Promise<void> {
  const statePath = resolveStatePathFromEnv();
  const lockFile = `${statePath}.lock`;
  await stopSharedManagedOpenCodeServerFromState({
    withLock: async (fn) => await withOpenCodeServerFileLock(lockFile, fn),
    readState: async () => await readStateFile(statePath),
    removeState: async () => {
      await rm(statePath, { force: true }).catch(() => {});
    },
    isPidAlive: isOpenCodeServerPidAlive,
    probeHealth: async (baseUrl) => await probeOpenCodeHealthBestEffort(baseUrl),
    getProcessInfo: async (pid) => await getProcessInfoBestEffort(pid),
    resolveLaunchSpec: resolveManagedOpenCodeLaunchSpecBestEffort,
    killPid: killPidBestEffort,
  }).then(() => {}).catch(() => {});
}

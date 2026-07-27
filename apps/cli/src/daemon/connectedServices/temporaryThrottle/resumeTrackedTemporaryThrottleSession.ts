import type { Credentials } from '@/persistence';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';

import { resolveRespawnSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveRespawnSessionRuntimeSnapshot';

import type { TemporaryThrottleResumeSource } from './resolveInactiveTemporaryThrottleResumeSource';

type ResolveRespawnOptions = (input: Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

export type TemporaryThrottleSessionResumeResult =
  | Readonly<{ status: 'resumed'; sessionId: string; spawnResult: SpawnSessionResult }>
  | Readonly<{
      status: 'unavailable';
      reason: 'session_id_missing' | 'spawn_options_missing';
    }>
  | Readonly<{
      status: 'failed';
      reason: 'spawn_failed';
      errorCode: string | null;
      spawnResult: SpawnSessionResult;
    }>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildTemporaryThrottleDefaultRespawnOptions(input: Readonly<{
  tracked: TemporaryThrottleResumeSource;
  sessionId: string;
  vendorResumeId: string;
}>): SpawnSessionOptions | null {
  const spawnOptions = input.tracked.spawnOptions;
  if (!spawnOptions || !normalizeString(spawnOptions.directory)) return null;
  const { pendingFirstInput: _pendingFirstInput, resume: _resume, sessionId: _sessionId, ...rest } = spawnOptions;
  return {
    ...rest,
    ...(input.vendorResumeId ? { resume: input.vendorResumeId } : {}),
    existingSessionId: input.sessionId,
    sessionId: undefined,
    approvedNewDirectoryCreation: true,
  };
}

function readSpawnErrorCode(result: SpawnSessionResult): string | null {
  return result.type === 'error' ? result.errorCode : null;
}

export async function resumeTrackedTemporaryThrottleSession(input: Readonly<{
  tracked: TemporaryThrottleResumeSource;
  sessionId?: string | null;
  credentials: Credentials | null;
  readCredentials: () => Promise<Credentials | null>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  resolveRespawnOptions?: ResolveRespawnOptions;
}>): Promise<TemporaryThrottleSessionResumeResult> {
  const sessionId = normalizeString(input.sessionId) || normalizeString(input.tracked.happySessionId);
  if (!sessionId) {
    return { status: 'unavailable', reason: 'session_id_missing' };
  }

  const vendorResumeId = normalizeString(input.tracked.vendorResumeId)
    || normalizeString(input.tracked.spawnOptions?.resume);
  const defaultOptions = buildTemporaryThrottleDefaultRespawnOptions({
    tracked: input.tracked,
    sessionId,
    vendorResumeId,
  });
  if (!defaultOptions) {
    return { status: 'unavailable', reason: 'spawn_options_missing' };
  }

  const resolveRespawnOptions = input.resolveRespawnOptions
    ?? ((params) => resolveRespawnSessionRuntimeSnapshot({
      ...params,
      credentials: input.credentials,
      readCredentials: input.readCredentials,
    }));
  const respawnOptions = await resolveRespawnOptions({
    sessionId,
    spawnOptions: input.tracked.spawnOptions ?? defaultOptions,
    vendorResumeId,
    defaultOptions,
  });
  const spawnResult = await input.spawnSession(respawnOptions);
  if (spawnResult.type === 'success') {
    return {
      status: 'resumed',
      sessionId: spawnResult.sessionId ?? sessionId,
      spawnResult,
    };
  }
  return {
    status: 'failed',
    reason: 'spawn_failed',
    errorCode: readSpawnErrorCode(spawnResult),
    spawnResult,
  };
}

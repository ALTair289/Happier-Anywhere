import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

export type RunnerAcceptance = NonNullable<
  Extract<SpawnSessionResult, { type: 'success' }>['runnerAcceptance']
>;

function normalizeNonce(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveExistingRunnerAcceptance(input: Readonly<{
  requestedSpawnNonce?: string;
  trackedSpawnNonces: readonly (string | undefined)[];
}>): RunnerAcceptance {
  const requestedSpawnNonce = normalizeNonce(input.requestedSpawnNonce);
  if (!requestedSpawnNonce || input.trackedSpawnNonces.length !== 1) {
    return 'preexisting_or_adopted';
  }

  return normalizeNonce(input.trackedSpawnNonces[0]) === requestedSpawnNonce
    ? 'same_request_runner'
    : 'preexisting_or_adopted';
}

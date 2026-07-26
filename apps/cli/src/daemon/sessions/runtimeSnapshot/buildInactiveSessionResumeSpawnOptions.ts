import {
  AGENTS_CORE,
  AGENT_IDS,
  resolveAgentIdFromFlavor,
  resolveAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';
import {
  AgentRuntimeDescriptorV1Schema,
  readAcpConfiguredBackendV1FromMetadata,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

export type BuildInactiveSessionResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId?: string | null;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  initialTranscriptAfterSeq?: number;
  executionAuthorization?: import('@happier-dev/protocol').SpawnSessionExecutionAuthorization;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function comparableDirectoryIdentity(value: string): string {
  const expanded = expandHomeDirPath(value).trim();
  const normalized = expanded.replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[a-zA-Z]:\//u.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function resolveExactPersistedRuntimeIdentity(
  metadata: Record<string, unknown>,
): Readonly<{
  backendTarget: NonNullable<SpawnSessionOptions['backendTarget']>;
  agentRuntimeDescriptorV1?: SpawnSessionOptions['agentRuntimeDescriptorV1'];
}> | null {
  const hasConfiguredBackendMetadata = Object.prototype.hasOwnProperty.call(metadata, 'acpConfiguredBackendV1');
  const configuredBackend = readAcpConfiguredBackendV1FromMetadata(metadata);
  if (hasConfiguredBackendMetadata && !configuredBackend) return null;

  const resolvedAgentId = resolveAgentIdFromSessionMetadata(metadata);
  const identityCandidates = new Set<AgentId>();
  if (resolvedAgentId) identityCandidates.add(resolvedAgentId);
  const flavorAgentId = resolveAgentIdFromFlavor(metadata.flavor);
  if (flavorAgentId) identityCandidates.add(flavorAgentId);

  let agentRuntimeDescriptorV1: SpawnSessionOptions['agentRuntimeDescriptorV1'] | undefined;
  if (metadata.agentRuntimeDescriptorV1 !== undefined) {
    const parsed = AgentRuntimeDescriptorV1Schema.safeParse(metadata.agentRuntimeDescriptorV1);
    if (!parsed.success || !(AGENT_IDS as readonly string[]).includes(parsed.data.providerId)) return null;
    agentRuntimeDescriptorV1 = parsed.data;
    identityCandidates.add(parsed.data.providerId as AgentId);
  }

  for (const candidateAgentId of AGENT_IDS) {
    const resumeField = 'vendorResumeIdField' in AGENTS_CORE[candidateAgentId].resume
      ? AGENTS_CORE[candidateAgentId].resume.vendorResumeIdField ?? null
      : null;
    if (resumeField && readNonEmptyString(metadata[resumeField])) {
      identityCandidates.add(candidateAgentId);
    }
  }

  if (configuredBackend) {
    identityCandidates.add('customAcp');
    if (identityCandidates.size !== 1) return null;
    return {
      backendTarget: {
        kind: 'configuredAcpBackend',
        backendId: configuredBackend.backendId,
      },
    };
  }

  if (!resolvedAgentId) return null;
  if (identityCandidates.size !== 1) return null;
  return {
    backendTarget: { kind: 'builtInAgent', agentId: resolvedAgentId },
    ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
  };
}

/**
 * Canonical provider-neutral inactive-session snapshot composition.
 *
 * This reconstructs only facts already owned by the session snapshot. It never
 * authorizes execution by itself; explicit callers must supply fresh execution
 * authorization and lifecycle owners decide whether the resulting resume may run.
 */
export function buildInactiveSessionResumeSpawnOptions(
  params: BuildInactiveSessionResumeSpawnOptionsParams,
): SpawnSessionOptions | null {
  const rawDirectory = readNonEmptyString(params.rawSession.path);
  const metadataDirectory = readNonEmptyString(params.metadata.path);
  if (
    rawDirectory
    && metadataDirectory
    && comparableDirectoryIdentity(rawDirectory) !== comparableDirectoryIdentity(metadataDirectory)
  ) return null;

  const rawMachineId = readNonEmptyString(params.rawSession.machineId);
  const metadataMachineId = readNonEmptyString(params.metadata.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) return null;

  const directory = rawDirectory ?? metadataDirectory;
  const machineId = rawMachineId ?? metadataMachineId ?? readNonEmptyString(params.fallbackMachineId);
  const runtimeIdentity = resolveExactPersistedRuntimeIdentity(params.metadata);
  if (!runtimeIdentity || !directory || !machineId) return null;

  const baseOptions: SpawnSessionOptions = {
    existingSessionId: params.sessionId,
    machineId,
    directory,
    backendTarget: runtimeIdentity.backendTarget,
    approvedNewDirectoryCreation: true,
    ...(runtimeIdentity.agentRuntimeDescriptorV1
      ? { agentRuntimeDescriptorV1: runtimeIdentity.agentRuntimeDescriptorV1 }
      : {}),
  };

  const resolved = resolveSessionRuntimeSnapshot({
    incomingOptions: baseOptions,
    persistedMetadata: params.metadata,
  }).spawnOptions;

  // Snapshot resolution deliberately strips request-scoped controls so they
  // cannot enter persisted spawn state. Reattach only the fresh controls from
  // this explicit invocation after canonical snapshot composition.
  return {
    ...resolved,
    ...(typeof params.initialTranscriptAfterSeq === 'number'
      && Number.isSafeInteger(params.initialTranscriptAfterSeq)
      && params.initialTranscriptAfterSeq >= 0
      ? { initialTranscriptAfterSeq: params.initialTranscriptAfterSeq }
      : {}),
    ...(params.executionAuthorization ? { executionAuthorization: params.executionAuthorization } : {}),
  };
}

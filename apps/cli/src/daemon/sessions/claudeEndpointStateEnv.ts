import { buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import {
  evaluateTerminalHostLivenessForRecovery,
} from '@/integrations/terminalHost/livenessPolicy';
import { resolveZellijSocketDir } from '@/integrations/zellij/socketDir';
import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  readClaudeEndpointDescriptor as readDefaultClaudeEndpointDescriptor,
  type AttachmentBoundClaudeEndpointState,
} from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';
import {
  resolveClaudeAdoptEndpointRecoveryForState as resolveDefaultClaudeAdoptEndpointRecoveryForState,
  type ClaudeAdoptEndpointRecovery,
} from '@/backends/claude/endpointRecovery/claudeEndpointRecovery';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/backends/catalog';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';

import {
  readSessionMarkerForPid as readDefaultSessionMarkerForPid,
  type DaemonSessionMarker,
} from '../sessionRegistry';

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

export type ClaudeEndpointRecoveryFenceReason =
  | 'live_attachment_adoption_unavailable'
  | 'recovery_probe_inconclusive';

export class ClaudeEndpointRecoveryFenceError extends Error {
  readonly code = 'claude_endpoint_recovery_fenced';

  constructor(readonly reason: ClaudeEndpointRecoveryFenceReason) {
    super(reason === 'recovery_probe_inconclusive'
      ? 'Claude terminal attachment liveness could not be established safely'
      : 'Claude terminal attachment is alive but its exact adoption proof is unavailable');
    this.name = 'ClaudeEndpointRecoveryFenceError';
  }
}

function isClaudeSpawnOptions(spawnOptions: SpawnSessionOptions): boolean {
  return spawnOptions.backendTarget?.kind === 'builtInAgent'
    && spawnOptions.backendTarget.agentId === 'claude';
}

export function buildClaudeEndpointStateEnvironmentVariables(
  state: AttachmentBoundClaudeEndpointState,
): Record<string, string> {
  return {
    [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(state),
  };
}

export function mergeClaudeEndpointStateIntoSpawnOptions(
  spawnOptions: SpawnSessionOptions,
  state: AttachmentBoundClaudeEndpointState | null | undefined,
): SpawnSessionOptions {
  if (!state || !isClaudeSpawnOptions(spawnOptions)) return spawnOptions;
  return {
    ...spawnOptions,
    environmentVariables: {
      ...(spawnOptions.environmentVariables ?? {}),
      ...buildClaudeEndpointStateEnvironmentVariables(state),
    },
  };
}

function clearClaudeEndpointStateFromSpawnOptions(spawnOptions: SpawnSessionOptions): SpawnSessionOptions {
  const environmentVariables = spawnOptions.environmentVariables;
  if (!environmentVariables || !(HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY in environmentVariables)) {
    return spawnOptions;
  }
  const {
    [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: _staleClaudeEndpointState,
    ...retainedEnvironmentVariables
  } = environmentVariables;
  return {
    ...spawnOptions,
    environmentVariables: retainedEnvironmentVariables,
  };
}

function buildReleasedV1RecoveryProbeHandle(
  attachmentInfo: Extract<TerminalAttachmentInfo, Readonly<{ version: 1 }>>,
  happyHomeDir: string,
) {
  const handle = buildTerminalHostHandleFromAttachmentMetadata(attachmentInfo.terminal);
  if (!handle || handle.kind !== 'zellij' || handle.socketDir) return handle;

  // Released v1 Zellij writers derived this root deterministically from their
  // owning Happier home but did not persist it. Reconstruct it only at this
  // upgrade boundary so the generic terminal-host probe remains fail-closed.
  return {
    ...handle,
    socketDir: resolveZellijSocketDir(happyHomeDir),
  };
}

export async function resolveClaudeEndpointRecoverySpawnOptions(params: Readonly<{
  previousPid?: number;
  happyHomeDir?: string;
  sessionId: string;
  defaultOptions: SpawnSessionOptions;
  readSessionMarkerForPid?: (pid: number) => Promise<DaemonSessionMarker | null>;
  readTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<TerminalAttachmentInfo | null>;
  readClaudeEndpointDescriptor?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentId: string;
  }>) => Promise<AttachmentBoundClaudeEndpointState | null>;
  removeTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId?: string;
    expectedTerminal?: TerminalAttachmentInfo['terminal'];
  }>) => Promise<boolean>;
  terminalHostAdapters?: TerminalHostAdapters;
  loadTerminalHostAdapters?: () => Promise<TerminalHostAdapters>;
  resolveAdoptEndpointRecovery?: (
    state: AttachmentBoundClaudeEndpointState,
  ) => Promise<ClaudeAdoptEndpointRecovery | null>;
  proveExactSessionRunnerAbsent?: () => Promise<boolean>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<SpawnSessionOptions> {
  if (!isClaudeSpawnOptions(params.defaultOptions)) return params.defaultOptions;
  const freshSpawnOptions = clearClaudeEndpointStateFromSpawnOptions(params.defaultOptions);

  let happyHomeDir = params.happyHomeDir?.trim() || null;
  if (!happyHomeDir && params.previousPid !== undefined) {
    const readSessionMarkerForPid = params.readSessionMarkerForPid ?? readDefaultSessionMarkerForPid;
    const marker = await readSessionMarkerForPid(params.previousPid).catch(() => null);
    if (!marker || marker.happySessionId !== params.sessionId) return freshSpawnOptions;
    happyHomeDir = marker.happyHomeDir;
  }
  if (!happyHomeDir) return freshSpawnOptions;

  const readTerminalAttachmentInfo = params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo;
  const attachmentInfo = await readTerminalAttachmentInfo({
    happyHomeDir,
    sessionId: params.sessionId,
  });
  if (!attachmentInfo) return freshSpawnOptions;

  const endpointState = attachmentInfo.version === 2
    ? await (params.readClaudeEndpointDescriptor ?? readDefaultClaudeEndpointDescriptor)({
        happyHomeDir,
        sessionId: params.sessionId,
        attachmentId: attachmentInfo.attachmentId,
      })
    : null;

  const handle = attachmentInfo.version === 2
    ? attachmentInfo.handle
    : buildReleasedV1RecoveryProbeHandle(attachmentInfo, happyHomeDir);
  if (!handle) return freshSpawnOptions;

  const terminalHostAdapters = params.terminalHostAdapters ?? await params.loadTerminalHostAdapters?.();
  const adapter = terminalHostAdapters?.[handle.kind];
  if (!adapter) return freshSpawnOptions;

  const probe = await evaluateTerminalHostLivenessForRecovery(adapter, handle);
  if (probe.status === 'alive') {
    if (
      attachmentInfo.version !== 2
      || !endpointState
      || endpointState.attachmentId !== attachmentInfo.attachmentId
    ) {
      throw new ClaudeEndpointRecoveryFenceError('live_attachment_adoption_unavailable');
    }
    const adoptEndpointRecovery = await (
      params.resolveAdoptEndpointRecovery ?? resolveDefaultClaudeAdoptEndpointRecoveryForState
    )(endpointState).catch(() => null);
    if (adoptEndpointRecovery) {
      return mergeClaudeEndpointStateIntoSpawnOptions(freshSpawnOptions, endpointState);
    }

    const exactSessionRunnerAbsent = await params.proveExactSessionRunnerAbsent?.().catch(() => false) ?? false;
    if (!exactSessionRunnerAbsent) {
      throw new ClaudeEndpointRecoveryFenceError('live_attachment_adoption_unavailable');
    }

    const disposition = await executeTerminalHostDisposition({
      happyHomeDir,
      sessionId: params.sessionId,
      expectedAttachmentId: attachmentInfo.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'unrecoverable_control_recovery' },
      adapter,
      readAttachmentInfo: params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo,
      removeAttachmentInfo: params.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo,
    }).catch(() => ({ status: 'parked' as const, reason: 'destroy_failed' as const }));
    if (disposition.status !== 'destroyed' || disposition.descriptorRetained) {
      throw new ClaudeEndpointRecoveryFenceError('live_attachment_adoption_unavailable');
    }
    await (params.onExactTerminalAttachmentRetired ?? notifyTerminalAttachmentRetiredThroughCatalog)({
      happyHomeDir,
      sessionId: params.sessionId,
      attachmentInfo,
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Unusable terminal host destroyed; Claude endpoint cleanup remains pending', {
        sessionId: params.sessionId,
        attachmentId: attachmentInfo.attachmentId,
        error,
      });
    });
    return freshSpawnOptions;
  }

  if (probe.status === 'inconclusive') {
    throw new ClaudeEndpointRecoveryFenceError('recovery_probe_inconclusive');
  }

  if (probe.status === 'dead') {
    if (attachmentInfo.version !== 2) return freshSpawnOptions;
    const disposition = await executeTerminalHostDisposition({
      happyHomeDir,
      sessionId: params.sessionId,
      expectedAttachmentId: attachmentInfo.attachmentId,
      intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
      adapter,
      readAttachmentInfo: params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo,
      removeAttachmentInfo: params.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo,
    }).catch(() => ({ status: 'parked' as const, reason: 'destroy_failed' as const }));
    if (disposition.status !== 'retired') return freshSpawnOptions;
    await (params.onExactTerminalAttachmentRetired ?? notifyTerminalAttachmentRetiredThroughCatalog)({
      happyHomeDir,
      sessionId: params.sessionId,
      attachmentInfo,
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Terminal host retired; Claude endpoint cleanup remains pending', {
        sessionId: params.sessionId,
        attachmentId: attachmentInfo.attachmentId,
        error,
      });
    });
  }

  return freshSpawnOptions;
}

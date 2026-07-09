import { buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import {
  evaluateTerminalHostLivenessForRecovery,
  shouldDiscardTerminalAttachmentAfterRecoveryProbe,
} from '@/integrations/terminalHost/livenessPolicy';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  readSessionMarkerForPid as readDefaultSessionMarkerForPid,
  type ClaudeEndpointState,
  type DaemonSessionMarker,
} from '../sessionRegistry';

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

function isClaudeSpawnOptions(spawnOptions: SpawnSessionOptions): boolean {
  return spawnOptions.backendTarget?.kind === 'builtInAgent'
    && spawnOptions.backendTarget.agentId === 'claude';
}

export function buildClaudeEndpointStateEnvironmentVariables(
  state: ClaudeEndpointState,
): Record<string, string> {
  return {
    [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(state),
  };
}

export function mergeClaudeEndpointStateIntoSpawnOptions(
  spawnOptions: SpawnSessionOptions,
  state: ClaudeEndpointState | null | undefined,
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

export async function resolveClaudeEndpointRecoveryRespawnOptions(params: Readonly<{
  previousPid: number;
  sessionId: string;
  defaultOptions: SpawnSessionOptions;
  readSessionMarkerForPid?: (pid: number) => Promise<DaemonSessionMarker | null>;
  readTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<TerminalAttachmentInfo | null>;
  removeTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedTerminal?: TerminalAttachmentInfo['terminal'];
  }>) => Promise<boolean>;
  terminalHostAdapters?: TerminalHostAdapters;
  loadTerminalHostAdapters?: () => Promise<TerminalHostAdapters>;
}>): Promise<SpawnSessionOptions> {
  if (!isClaudeSpawnOptions(params.defaultOptions)) return params.defaultOptions;

  const readSessionMarkerForPid = params.readSessionMarkerForPid ?? readDefaultSessionMarkerForPid;
  const marker = await readSessionMarkerForPid(params.previousPid).catch(() => null);
  if (!marker?.claudeEndpointState || marker.happySessionId !== params.sessionId) return params.defaultOptions;

  const readTerminalAttachmentInfo = params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo;
  const attachmentInfo = await readTerminalAttachmentInfo({
    happyHomeDir: marker.happyHomeDir,
    sessionId: params.sessionId,
  });
  if (!attachmentInfo) return params.defaultOptions;

  const handle = buildTerminalHostHandleFromAttachmentMetadata(attachmentInfo.terminal);
  if (!handle) return params.defaultOptions;

  const terminalHostAdapters = params.terminalHostAdapters ?? await params.loadTerminalHostAdapters?.();
  const adapter = terminalHostAdapters?.[handle.kind];
  if (!adapter) return params.defaultOptions;

  const probe = await evaluateTerminalHostLivenessForRecovery(adapter, handle);
  if (probe.liveness?.paneAlive === true) {
    return mergeClaudeEndpointStateIntoSpawnOptions(params.defaultOptions, marker.claudeEndpointState);
  }

  if (shouldDiscardTerminalAttachmentAfterRecoveryProbe(probe)) {
    const removeTerminalAttachmentInfo = params.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo;
    await removeTerminalAttachmentInfo({
      happyHomeDir: marker.happyHomeDir,
      sessionId: params.sessionId,
      expectedTerminal: attachmentInfo.terminal,
    }).catch(() => false);
  }

  return params.defaultOptions;
}

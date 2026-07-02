import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { PiBackendOptions } from '@/backends/pi/acp/backend';
import { publishPiSessionIdMetadata } from '@/backends/pi/utils/piSessionIdMetadata';

export function createPiAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
  pendingQueueDrainMaxPopPerWake?: number;
}) {
  const lastPublishedPiSessionId = { value: null as string | null };

  return createCatalogProviderAcpRuntime<PiBackendOptions>({
    provider: 'pi',
    loggerLabel: 'PiACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    backendOptions: {
      env: process.env,
    },
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    inFlightSteer: { enabled: true },
    onSessionIdChange: (nextSessionId) => {
      publishPiSessionIdMetadata({
        session: params.session,
        getPiSessionId: () => nextSessionId,
        cwd: params.directory,
        processEnv: process.env,
        lastPublished: lastPublishedPiSessionId,
      });
    },
  });
}

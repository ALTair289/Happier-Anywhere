import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';

export type ExecutionRunBackendStartContext = Readonly<{
  intentInput?: unknown;
  retentionPolicy?: string;
  intent?: string;
}>;

export type ExecutionRunBackendIsolation = Readonly<{
  env?: Record<string, string>;
  settingsPath?: string;
}>;

export type ExecutionRunBackendFactoryOptions = Readonly<{
  cwd: string;
  backendId: string;
  modelId?: string;
  /**
   * Optional canonical config-option overrides for the run (e.g. `reasoning_effort`), SAME shape as
   * session spawn's `sessionConfigOptionOverrides`. Providers extract the options they support
   * (e.g. Codex reasoning effort) and apply them to the spawned backend config.
   */
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  permissionHandler: AcpPermissionHandler;
  start?: ExecutionRunBackendStartContext | null;
  isolation?: ExecutionRunBackendIsolation;
}>;

export type ExecutionRunBackendFactory = (opts: ExecutionRunBackendFactoryOptions) => AgentBackend;

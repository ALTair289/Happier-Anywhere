import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { PermissionMode } from '@/api/types';
import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { withExecutionRunBackendModelOptions } from '@/agent/executionRuns/runtime/applyExecutionRunBackendModelOptions';

/**
 * Common option shape passed to simple provider `create*Backend` functions
 * from the execution-run factory path.
 */
export interface SimpleExecutionRunBackendOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

/**
 * Creates an {@link ExecutionRunBackendFactory} for providers whose backend
 * constructor accepts the standard `{ cwd, env, permissionHandler, permissionMode }` shape
 * (or a subset of it).
 *
 * This eliminates near-identical boilerplate across auggie, copilot, kilo, kimi, pi, and qwen.
 */
export function createSimpleExecutionRunBackendFactory<
  T extends { cwd: string; env?: NodeJS.ProcessEnv; permissionMode?: PermissionMode },
>(
  createBackend: (opts: T) => AgentBackend,
): ExecutionRunBackendFactory {
  return (opts) => {
    const backendOpts: SimpleExecutionRunBackendOptions = {
      cwd: opts.cwd,
      env: opts.isolation?.env,
      permissionHandler: opts.permissionHandler,
      permissionMode: permissionModeForExecutionRunPolicy(opts.permissionMode),
    };
    // Run modelId + canonical config overrides are part of the execution-run contract. Apply them
    // capability-driven (no provider-name branching): backends that expose the setters get them, the
    // rest are returned untouched. Fixes the shared factory silently dropping model/effort.
    return withExecutionRunBackendModelOptions(createBackend(backendOpts as T), {
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
      ...(opts.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
        : {}),
    });
  };
}

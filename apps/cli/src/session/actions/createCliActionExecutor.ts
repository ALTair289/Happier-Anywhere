import { readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

function resolveCallerPermissionMode(params: Parameters<typeof createCliActionExecutorHarness>[0]): string | null {
  const mode = params.getCallerPermissionMode?.();
  return typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : null;
}

export function createCliActionExecutor(
  params: Parameters<typeof createCliActionExecutorHarness>[0],
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const base = createCliActionExecutorHarness(params).executor;

  return {
    execute: async (actionId, input, context) => {
      const callerPermissionMode = resolveCallerPermissionMode(params);
      return await base.execute(actionId, input, {
        ...(context ?? {}),
        surface: context?.surface ?? 'cli',
        ...(callerPermissionMode ? { callerPermissionMode } : {}),
        actionsSettings: readActionsSettingsFromEnv() as any,
      });
    },
  };
}

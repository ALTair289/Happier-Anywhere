/**
 * Claude Code command hooks cannot be truly unbounded: the hook runner enforces a finite timeout.
 * Happier therefore uses a large, shared ceiling for provider-side hook forwarders and keeps
 * every Claude command-hook permission path aligned to this resolver.
 */

export const CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS_ENV_VAR = 'HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS';
export const DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_PROVIDER_HOOK_CEILING_MS = DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS * 1000;

export type ClaudePermissionHookTimeoutOptions = Readonly<{
  permissionHookTimeoutSeconds?: number;
  env?: NodeJS.ProcessEnv;
}>;

function readPositiveIntEnv(env: NodeJS.ProcessEnv, envVarName: string): number | null {
  const raw = env[envVarName];
  if (typeof raw !== 'string') return null;
  const parsed = Number(raw.trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return null;
}

export function resolveClaudePermissionHookTimeoutSeconds(
  options: ClaudePermissionHookTimeoutOptions = {},
): number {
  const raw = options.permissionHookTimeoutSeconds;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }

  const envOverride = readPositiveIntEnv(
    options.env ?? process.env,
    CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS_ENV_VAR,
  );
  if (envOverride !== null) {
    return envOverride;
  }

  return DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS;
}

export function resolveClaudePermissionHookTimeoutMs(
  options: ClaudePermissionHookTimeoutOptions = {},
): number {
  return resolveClaudePermissionHookTimeoutSeconds(options) * 1000;
}

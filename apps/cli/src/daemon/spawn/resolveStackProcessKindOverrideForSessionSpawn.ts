export function resolveStackProcessKindOverrideForSessionSpawn(
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const hasStackContext =
    Boolean(String(processEnv.HAPPIER_STACK_STACK ?? '').trim()) ||
    Boolean(String(processEnv.HAPPIER_STACK_ENV_FILE ?? '').trim()) ||
    Boolean(String(processEnv.HAPPIER_STACK_REPO_DIR ?? '').trim());
  if (!hasStackContext) return {};

  // In stack mode, infra processes (server/daemon/expo) are tagged as `infra` to support
  // stack stop/owner-death sweeps. Daemon-spawned session runners must never inherit that
  // tag, otherwise a stack reload can accidentally sweep and kill active sessions/LLM turns.
  return { HAPPIER_STACK_PROCESS_KIND: 'session' };
}

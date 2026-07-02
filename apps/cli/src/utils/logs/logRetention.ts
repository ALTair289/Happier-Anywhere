/**
 * Centralized log-retention policy for ~/.happier/logs.
 *
 * One log file is created per process boot, so retention is count-based:
 * - daemon logs (`*-daemon.log`) keep the newest {@link DEFAULT_DAEMON_LOG_KEEP_COUNT}
 * - session logs (all other `*.log`) keep the newest {@link DEFAULT_SESSION_LOG_KEEP_COUNT}
 *
 * Both budgets are env-overridable (`HAPPIER_DAEMON_LOG_KEEP_COUNT`,
 * `HAPPIER_SESSION_LOG_KEEP_COUNT`) for support/debugging scenarios.
 */

export const DAEMON_LOG_SUFFIX = '-daemon.log';
export const LOG_FILE_SUFFIX = '.log';

export const DEFAULT_DAEMON_LOG_KEEP_COUNT = 50;
export const DEFAULT_SESSION_LOG_KEEP_COUNT = 200;

type EnvLike = Readonly<Record<string, string | undefined>>;

function resolveKeepCount(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function resolveDaemonLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_DAEMON_LOG_KEEP_COUNT, DEFAULT_DAEMON_LOG_KEEP_COUNT);
}

export function resolveSessionLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_SESSION_LOG_KEEP_COUNT, DEFAULT_SESSION_LOG_KEEP_COUNT);
}

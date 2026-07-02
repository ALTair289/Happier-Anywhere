import { join } from 'node:path';

export function resolveOpenCodeManagedServersLogDir(logsDir: string): string {
  return join(logsDir, 'opencode-managed-servers');
}

/**
 * Local-time `YYYY-MM-DD-HH-MM-SS` stamp, matching the repo's other log filenames (see
 * `ui/logger.ts`). The `sv-SE` locale yields `YYYY-MM-DD HH:MM:SS`, then separators are normalized.
 */
export function formatOpenCodeManagedServerLogTimestamp(date: Date = new Date()): string {
  return date
    .toLocaleString('sv-SE', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    .replace(/[: ]/g, '-')
    .replace(/,/g, '');
}

/**
 * `<logsDir>/opencode-managed-servers/<YYYY-MM-DD-HH-MM-SS>-port-<port>-pid-<pid-or-pending>.log`.
 */
export function resolveOpenCodeManagedServerLogPath(params: Readonly<{
  logsDir: string;
  port: number;
  pid: number | null;
  now?: Date;
}>): string {
  const timestamp = formatOpenCodeManagedServerLogTimestamp(params.now ?? new Date());
  const portLabel = Number.isInteger(params.port) && params.port > 0 ? String(params.port) : 'unknown';
  const pidLabel = Number.isInteger(params.pid) && (params.pid ?? -1) > 0 ? String(params.pid) : 'pending';
  return join(
    resolveOpenCodeManagedServersLogDir(params.logsDir),
    `${timestamp}-port-${portLabel}-pid-${pidLabel}.log`,
  );
}

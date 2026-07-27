export type DaemonControlLivenessProbeResult =
  | 'running'
  | 'pid_not_running'
  | 'unauthorized'
  | 'unreachable';

/**
 * Proves that persisted daemon coordinates still name a live Happier daemon.
 * The authenticated ping defeats PID/port reuse; neither PID liveness nor a
 * stale state-file generation is execution authority by itself.
 */
export async function probeDaemonAuthenticatedControl(input: Readonly<{
  pid: number;
  httpPort: number;
  controlToken: string;
  timeoutMs: number;
}>): Promise<DaemonControlLivenessProbeResult> {
  try {
    process.kill(input.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
      ? 'pid_not_running'
      : 'unreachable';
  }

  try {
    const response = await fetch(`http://127.0.0.1:${input.httpPort}/ping`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-happier-daemon-token': input.controlToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (!response.ok) return 'unreachable';
    const payload = await response.json() as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Readonly<{ status?: unknown }>).status === 'ok'
      ? 'running'
      : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

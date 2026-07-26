import { readProcessRunState, type ProcessRunState } from '@/daemon/processRunState';

type RunnerIdentity = Readonly<{
  pid: number;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function waitForTrackedRunnerProcessesExit(params: Readonly<{
  runners: readonly RunnerIdentity[];
  timeoutMs: number;
  pollIntervalMs: number;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
}>): Promise<boolean> {
  const readRunState = params.readRunState ?? readProcessRunState;
  const remaining = new Map(
    params.runners
      .filter((runner) => Number.isInteger(runner.pid) && runner.pid > 0)
      .map((runner) => [runner.pid, runner] as const),
  );
  if (remaining.size === 0) return true;

  const timeoutMs = Math.max(0, Math.trunc(params.timeoutMs));
  const pollIntervalMs = Math.max(0, Math.trunc(params.pollIntervalMs));
  const deadlineMs = Date.now() + timeoutMs;
  do {
    for (const pid of remaining.keys()) {
      const runState = await readRunState(pid);
      if (runState === 'dead' || runState === 'zombie') {
        remaining.delete(pid);
      }
    }
    if (remaining.size === 0) return true;
    if (Date.now() >= deadlineMs) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  } while (Date.now() <= deadlineMs);

  return false;
}

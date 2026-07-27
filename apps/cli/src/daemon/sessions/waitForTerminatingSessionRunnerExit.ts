import {
  resolveSessionRunnerResumeDecision,
  type SessionRunnerServiceabilityProbe,
} from './isSessionRunnerActive';

export async function waitForTerminatingSessionRunnerExit(params: Readonly<{
  initialProbe: SessionRunnerServiceabilityProbe;
  probe: () => Promise<SessionRunnerServiceabilityProbe>;
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  let current = params.initialProbe;
  if (resolveSessionRunnerResumeDecision(current).action !== 'wait_for_exit') return current;

  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? (async (delayMs: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  });
  const deadline = now() + Math.max(0, params.timeoutMs);
  const pollIntervalMs = Math.max(1, params.pollIntervalMs);

  while (now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    current = await params.probe();
    if (resolveSessionRunnerResumeDecision(current).action !== 'wait_for_exit') return current;
  }
  return current;
}

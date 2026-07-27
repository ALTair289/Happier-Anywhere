export function assertCurrentDaemonSelfRestartAuthorization(input: Readonly<{
  startupSource: string;
  correlationId?: string | null;
  deadlineMs?: string | number | null;
  nowMs?: number;
}>): void {
  if (input.startupSource !== 'self-restart') return;

  const correlationId = String(input.correlationId ?? '').trim();
  const deadlineMs = Number(input.deadlineMs);
  const nowMs = Number(input.nowMs ?? Date.now());
  if (!correlationId || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('Daemon self-restart successor is missing a valid authorization');
  }
  if (!Number.isFinite(nowMs) || nowMs > deadlineMs) {
    throw new Error(`Daemon self-restart authorization expired (${correlationId})`);
  }
}

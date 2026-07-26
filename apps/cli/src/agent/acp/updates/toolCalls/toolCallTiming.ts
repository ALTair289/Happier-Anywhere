export function formatDuration(startTime: number | undefined, now: number = Date.now()): string {
  if (!startTime) return 'unknown';
  return `${((now - startTime) / 1_000).toFixed(2)}s`;
}

export function formatDurationMinutes(startTime: number | undefined, now: number = Date.now()): string {
  if (!startTime) return 'unknown';
  return ((now - startTime) / 1_000 / 60).toFixed(2);
}

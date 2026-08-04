export function readClaudeJsonlTimestampMs(value: unknown): number | null {
  const rawTimestamp = value && typeof value === 'object'
    ? (value as Record<string, unknown>).timestamp
    : undefined;
  if (typeof rawTimestamp !== 'string') return null;
  const parsed = Date.parse(rawTimestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

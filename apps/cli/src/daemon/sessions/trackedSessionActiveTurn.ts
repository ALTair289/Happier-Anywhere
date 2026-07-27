import type { TrackedSession } from '../types';

export type TrackedSessionActiveTurn = Readonly<{
  sessionId: string;
  turnId: string;
  markerPid: number;
}>;

/**
 * P1-owned exact active-turn Interface. Consumers must treat `null` as no
 * settlement input and must never infer a turn from transcript or server state.
 */
export function resolveTrackedSessionActiveTurn(
  tracked: Pick<TrackedSession, 'pid' | 'sessionRunnerPid' | 'happySessionId' | 'activeTurnId'>,
): TrackedSessionActiveTurn | null {
  const sessionId = tracked.happySessionId?.trim() ?? '';
  const turnId = tracked.activeTurnId?.trim() ?? '';
  if (!sessionId || !turnId) return null;
  return {
    sessionId,
    turnId,
    markerPid: tracked.sessionRunnerPid ?? tracked.pid,
  };
}

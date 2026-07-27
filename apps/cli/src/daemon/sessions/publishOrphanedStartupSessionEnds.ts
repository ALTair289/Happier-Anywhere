import type { ExactSessionTurnEndMutationV1 } from '@happier-dev/protocol';

import { removeSessionMarker } from '../sessionRegistry';
import { stageObservedExit } from './stageObservedExit';

export type OrphanedDeadDaemonSession = Readonly<{
  sessionId: string;
  pid: number;
  activeTurnId?: string;
}>;

/**
 * Startup Adapter for dead daemon-owned markers. The staging owner makes the
 * exact-turn decision; this Adapter supplies persisted marker evidence only.
 */
export async function publishOrphanedStartupSessionEnds(params: Readonly<{
  apiMachine: {
    enqueueDaemonTerminalExactTurnEnd: (mutation: ExactSessionTurnEndMutationV1) => Promise<void>;
  };
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  now?: () => number;
  removeSessionMarkerFn?: typeof removeSessionMarker;
}>): Promise<void> {
  const now = params.now ?? (() => Date.now());
  const removeSessionMarkerFn = params.removeSessionMarkerFn ?? removeSessionMarker;

  for (const orphanedSession of params.orphanedDeadDaemonSessions) {
    await stageObservedExit({
      trackedSession: {
        happySessionId: orphanedSession.sessionId,
        pid: orphanedSession.pid,
        ...(orphanedSession.activeTurnId ? { activeTurnId: orphanedSession.activeTurnId } : {}),
      },
      observedAt: now(),
      enqueueExactTurnEnd: (mutation) => params.apiMachine.enqueueDaemonTerminalExactTurnEnd(mutation),
      releaseMarkerEvidence: async ({ markerPid }) => {
        await removeSessionMarkerFn(markerPid);
      },
    });
  }
}

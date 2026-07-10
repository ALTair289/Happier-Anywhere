import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';

export type ApplyAuthGroupGenerationSessionTarget = Readonly<{
  sessionId: string;
  fromProfileId: string | null;
}>;

export type ApplyAuthGroupGenerationToSessionsResult = Readonly<{
  ok: boolean;
  appliedSessionCount: number;
  restartRequestedSessionCount: number;
  skippedIdleSessionCount: number;
  failedSessionCount: number;
  failures: ReadonlyArray<Readonly<{ sessionId: string; errorCode: string | null }>>;
}>;

/**
 * Sessions are independent (the switch FSM serializes per session, and the shared-home
 * materializer owns its own write locks), but each apply can legitimately wait a full
 * turn-boundary deferral window before it may restart. Bounded parallelism keeps the fan-out's
 * wall-clock at ~one deferral window instead of the sum across sessions (the sequential shape
 * guaranteed the manual-apply ack timed out on every pool with active sessions — live incident
 * 2026-07-10), while the cap prevents a large pool from thundering-herd restarting the machine.
 */
const APPLY_FANOUT_CONCURRENCY = 4;

/**
 * Fan a server-committed auth-group generation out to the live sessions bound to the group.
 * Pure orchestration over the injected per-session FSM apply: collects per-session outcomes,
 * never lets one session's failure abort the others, and reports the same counts shape the
 * settings UI reconcile flow consumes.
 */
export async function applyConnectedServiceAuthGroupGenerationToSessions(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  generation: number;
  reason: string;
  switchReason: ConnectedServiceSessionAuthSwitchReason;
  targets: ReadonlyArray<ApplyAuthGroupGenerationSessionTarget>;
  applyAuthGeneration: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    generation: number;
    reason: string;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    fromProfileId: string | null;
  }>) => Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string }>>;
}>): Promise<ApplyAuthGroupGenerationToSessionsResult> {
  let appliedSessionCount = 0;
  let restartRequestedSessionCount = 0;
  const failures: Array<Readonly<{ sessionId: string; errorCode: string | null }>> = [];

  const queue = [...input.targets];
  const runWorker = async (): Promise<void> => {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      try {
        const result = await input.applyAuthGeneration({
          sessionId: target.sessionId,
          serviceId: input.serviceId,
          groupId: input.groupId,
          activeProfileId: input.activeProfileId,
          generation: input.generation,
          reason: input.reason,
          switchReason: input.switchReason,
          fromProfileId: target.fromProfileId,
        });
        if (result.ok) {
          if (result.action === 'restart_requested') {
            restartRequestedSessionCount += 1;
          } else {
            appliedSessionCount += 1;
          }
        } else {
          failures.push({ sessionId: target.sessionId, errorCode: result.errorCode ?? null });
        }
      } catch {
        failures.push({ sessionId: target.sessionId, errorCode: 'apply_generation_threw' });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(APPLY_FANOUT_CONCURRENCY, Math.max(1, input.targets.length)) }, runWorker),
  );

  return {
    ok: failures.length === 0,
    appliedSessionCount,
    restartRequestedSessionCount,
    skippedIdleSessionCount: 0,
    failedSessionCount: failures.length,
    failures,
  };
}

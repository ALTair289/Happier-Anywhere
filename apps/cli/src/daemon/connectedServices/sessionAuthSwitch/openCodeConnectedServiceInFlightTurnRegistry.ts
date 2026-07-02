/**
 * Process-global bridge that lets the OpenCode managed-server release path (a pure module under
 * `backends/opencode/server/sharedManagedServer.ts`) learn whether a connected-service session
 * currently has an in-flight turn, without taking a hard dependency on the daemon's switch
 * deferral queue.
 *
 * The daemon's connected-service turn deferral queue is the in-memory source of truth for
 * per-session turn-in-flight state (`isTurnInFlight`). `startDaemon` registers that query here once
 * the queue is created and clears it on shutdown. The managed-server release path consults this via
 * a best-effort dynamic import (mirroring how it reads tracked session-marker claims).
 *
 * This is Lane F's "reflect the active turn in the claim/lease" wiring: `releaseForAuthSwitch` must
 * never kill a managed server whose sole remaining claimant (the switching session) still has an
 * in-flight OpenCode turn. Fail-closed everywhere: a missing/throwing provider reports "not
 * in-flight" so the registry can never wedge a release indefinitely on a stale signal.
 */
type OpenCodeConnectedServiceInFlightTurnProvider = (sessionId: string) => boolean;

let inFlightTurnProvider: OpenCodeConnectedServiceInFlightTurnProvider | null = null;

/**
 * Register (or clear, with `null`) the per-session in-flight-turn query. Called by the daemon with
 * the connected-service turn deferral queue's `isTurnInFlight` after the queue is created, and with
 * `null` on shutdown.
 */
export function setOpenCodeConnectedServiceInFlightTurnProvider(
  provider: OpenCodeConnectedServiceInFlightTurnProvider | null,
): void {
  inFlightTurnProvider = provider;
}

/**
 * Best-effort: does the given connected-service session currently have an in-flight OpenCode turn?
 * Returns `false` when no provider is registered, the session id is blank, or the provider throws.
 */
export function isOpenCodeConnectedServiceTurnInFlight(sessionId: string): boolean {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId || !inFlightTurnProvider) return false;
  try {
    return inFlightTurnProvider(normalizedSessionId) === true;
  } catch {
    return false;
  }
}

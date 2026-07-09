import type { AgentState, InFlightSteerUnavailableReason } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 1000;

export type ClaudeInFlightSteerAvailabilitySnapshot = Readonly<{
  available: boolean;
  /** `user_terminal_draft` = lane-X starvation escalation (a composer draft blocks steering). */
  reason: 'unsafe_window' | 'user_terminal_draft' | null;
}>;

export type ClaudeInFlightSteerCapabilityPublisher = Readonly<{
  publish: (snapshot: ClaudeInFlightSteerAvailabilitySnapshot) => void;
  dispose: () => void;
}>;

/**
 * Publishes the Claude Unified steer-availability snapshot (lane P, O-design Seam A) into
 * `agentState.capabilities` so the UI's delivery decision can stop pretending a non-steerable send
 * was delivered. Consumes the evaluator's de-duplicated tee and:
 *
 * - maps unavailable → `turn_settling` when the CANONICAL turn (N2 probe) is no longer active —
 *   one turn-truth owner, no second turn-state source;
 * - de-duplicates identical states and rate-limits flapping screen vetoes with a trailing
 *   converging write (`minPublishIntervalMs`, default 1s);
 * - stamps `inFlightSteerStateAt` so the UI can ignore stale snapshots.
 */
export function createClaudeInFlightSteerCapabilityPublisher(opts: Readonly<{
  session: { updateAgentState: (updater: (current: AgentState) => AgentState) => Promise<void> | void };
  /** N2 canonical-turn probe; absent counts as active (fail-closed toward unsafe_window). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  nowMs?: (() => number) | undefined;
  minPublishIntervalMs?: number | undefined;
}>): ClaudeInFlightSteerCapabilityPublisher {
  const nowMs = opts.nowMs ?? Date.now;
  const minPublishIntervalMs = Math.max(0, opts.minPublishIntervalMs ?? DEFAULT_MIN_PUBLISH_INTERVAL_MS);

  let disposed = false;
  let lastPublishedKey: string | null = null;
  let lastPublishAtMs: number | null = null;
  let pendingSnapshot: ClaudeInFlightSteerAvailabilitySnapshot | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  function resolveReason(snapshot: ClaudeInFlightSteerAvailabilitySnapshot): InFlightSteerUnavailableReason | null {
    if (snapshot.available) return null;
    const canonicalActive = opts.isCanonicalTurnActive?.() ?? true;
    return canonicalActive ? (snapshot.reason ?? 'unsafe_window') : 'turn_settling';
  }

  function write(snapshot: ClaudeInFlightSteerAvailabilitySnapshot): void {
    const reason = resolveReason(snapshot);
    const terminalComposerDraftPresent = !snapshot.available && snapshot.reason === 'user_terminal_draft';
    const key = `${snapshot.available}:${reason ?? ''}:${terminalComposerDraftPresent}`;
    if (key === lastPublishedKey) return;
    lastPublishedKey = key;
    lastPublishAtMs = nowMs();
    const stateAt = lastPublishAtMs;
    updateAgentStateBestEffort(
      opts.session,
      (currentState) => ({
        ...currentState,
        capabilities: {
          ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
          inFlightSteerAvailable: snapshot.available,
          inFlightSteerUnavailableReason: reason,
          inFlightSteerStateAt: stateAt,
          terminalComposerClearSupported: true,
          terminalComposerDraftPresent,
        },
      }),
      '[unified]',
      'in_flight_steer_capabilities',
    );
  }

  function flushPending(): void {
    trailingTimer = null;
    if (disposed || pendingSnapshot === null) return;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    write(snapshot);
  }

  return {
    publish(snapshot) {
      if (disposed) return;
      const withinInterval = lastPublishAtMs !== null && nowMs() - lastPublishAtMs < minPublishIntervalMs;
      if (!withinInterval) {
        write(snapshot);
        return;
      }
      // Flap guard: coalesce rapid changes into one trailing write that converges on the latest.
      pendingSnapshot = snapshot;
      if (trailingTimer === null) {
        const delayMs = Math.max(0, minPublishIntervalMs - (nowMs() - (lastPublishAtMs ?? 0)));
        trailingTimer = setTimeout(flushPending, delayMs);
        trailingTimer.unref?.();
      }
    },
    dispose() {
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      pendingSnapshot = null;
      if (lastPublishedKey !== null) {
        write({ available: true, reason: null });
      }
      disposed = true;
    },
  };
}

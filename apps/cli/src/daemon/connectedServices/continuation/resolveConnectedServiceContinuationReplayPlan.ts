import type { SessionContinuationReplayModeV1 } from '@happier-dev/protocol';
import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';

export type ConnectedServiceContinuationReplayPlan = Readonly<{
  continuationRequired?: boolean;
  replayMode: SessionContinuationReplayModeV1;
}>;

export function shouldReleaseConnectedServiceRestartBoundaryForReplayPlan(
  plan: ConnectedServiceContinuationReplayPlan,
): boolean {
  return plan.continuationRequired !== false && plan.replayMode !== 'suppress';
}

export function resolveConnectedServiceContinuationReplayPlan(input: Readonly<{
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  hasProviderActivityThisTurn: boolean;
  providerActivityEvidence?: 'activity_found' | 'no_activity_found' | 'unknown';
  /**
   * True when the switch is interrupting live in-flight work: a turn is in flight at plan time, or
   * the deferral's forced boundary just closed one. Gates PLANNED switches only.
   */
  turnInterrupted?: boolean;
}>): ConnectedServiceContinuationReplayPlan {
  if (input.switchReason === 'pre_turn_group_policy') {
    return {
      continuationRequired: false,
      replayMode: 'suppress',
    };
  }

  // A MANUAL switch is boundary-deferred by construction: it interrupts work only when the deferral
  // was FORCED mid-turn (or a live turn exists at plan time). Activity flags/durable evidence must
  // NOT arm a continuation here — `hasProviderActivityThisTurn` survives the turn's end, so an idle
  // session that ever completed a turn reads stale-true and would be sent a spurious "continue"
  // (live regression 2026-07-10). Failure-driven switches keep evidence semantics below: there the
  // interruption is the failure itself and the turn is typically already closed by failTurn.
  if (input.switchReason === 'manual' && input.turnInterrupted !== true) {
    return {
      continuationRequired: false,
      replayMode: 'suppress',
    };
  }

  if (input.hasProviderActivityThisTurn || input.providerActivityEvidence === 'activity_found') {
    return {
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    };
  }

  // The daemon-local deferral queue is best-effort process state and is wiped by
  // restarts. Only durable transcript evidence may authorize replaying the
  // original committed user prompt.
  if (input.providerActivityEvidence === 'no_activity_found') {
    return {
      continuationRequired: true,
      replayMode: 'retry_original_user_message',
    };
  }

  return {
    continuationRequired: true,
    replayMode: 'continuation_prompt',
  };
}

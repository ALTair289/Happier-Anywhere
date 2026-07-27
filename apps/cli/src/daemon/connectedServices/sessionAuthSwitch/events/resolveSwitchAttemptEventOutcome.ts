export type SwitchAttemptEventAction = 'restart_requested' | 'hot_applied' | 'metadata_updated';
export type SwitchAttemptEventOutcome = 'succeeded' | 'failed' | 'observed' | 'scheduled_retry' | 'terminal';
export type SwitchAttemptEventOutcomeAction = 'hot_applied' | 'restarted' | 'metadata_updated' | 'credential_refreshed' | 'none';
export type SwitchAttemptEventAttemptedContinuityMode = 'hot_apply' | 'restart' | 'metadata_only' | 'credential_refresh';
type SwitchContinuityMode = 'restart_rematerialize' | 'hot_apply' | 'unsupported';

export type SwitchAttemptEventOutcomeProjection = Readonly<{
  action: SwitchAttemptEventAction;
  attemptedContinuityMode: SwitchAttemptEventAttemptedContinuityMode;
  outcome: SwitchAttemptEventOutcome;
  outcomeAction: SwitchAttemptEventOutcomeAction;
}>;

export function resolveSwitchAttemptEventOutcomeForSuccess(input: Readonly<{
  action: 'restart_requested' | 'hot_applied' | 'metadata_updated';
}>): SwitchAttemptEventOutcomeProjection {
  switch (input.action) {
    case 'hot_applied':
      return {
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
      };
    case 'metadata_updated':
      // A metadata-only commit performed no restart and verified no provider adoption — under the
      // provider-outcome-proof doctrine it must render as an observed intermediate, never as a
      // final success the session could subsequently strand behind (INC-7). Failure projections
      // spread this shape and override `outcome: 'failed'`, which stays correct.
      return {
        action: 'metadata_updated',
        attemptedContinuityMode: 'metadata_only',
        outcome: 'observed',
        outcomeAction: 'metadata_updated',
      };
    case 'restart_requested':
      return {
        action: 'restart_requested',
        attemptedContinuityMode: 'restart',
        // Request acceptance proves neither process exit nor replacement/provider adoption.
        // Those later supervision facts own any completed-restart projection.
        outcome: 'observed',
        outcomeAction: 'none',
      };
  }
}

export function resolveSwitchAttemptEventOutcomeForFailure(input: Readonly<{
  errorCode: string;
  attemptedAction?: SwitchAttemptEventAction;
  continuityByServiceId?: Readonly<Record<string, SwitchContinuityMode>>;
}>): SwitchAttemptEventOutcomeProjection {
  if (input.attemptedAction) {
    return {
      ...resolveSwitchAttemptEventOutcomeForSuccess({ action: input.attemptedAction }),
      outcome: 'failed',
      outcomeAction: 'none',
    };
  }

  if (
    input.errorCode === 'hot_apply_failed'
    || input.errorCode === 'hot_apply_succeeded_but_recovery_failed'
    || everyContinuityMode(input.continuityByServiceId, 'hot_apply')
  ) {
    return {
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
    };
  }

  return {
    action: 'restart_requested',
    attemptedContinuityMode: 'restart',
    outcome: 'failed',
    outcomeAction: 'none',
  };
}

function everyContinuityMode(
  continuityByServiceId: Readonly<Record<string, SwitchContinuityMode>> | undefined,
  mode: SwitchContinuityMode,
): boolean {
  const continuityModes = Object.values(continuityByServiceId ?? {});
  return continuityModes.length > 0 && continuityModes.every((entry) => entry === mode);
}

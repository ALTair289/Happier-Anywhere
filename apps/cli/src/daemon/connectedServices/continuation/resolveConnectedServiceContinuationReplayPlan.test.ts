import { describe, expect, it } from 'vitest';

import {
  resolveConnectedServiceContinuationReplayPlan,
  shouldReleaseConnectedServiceRestartBoundaryForReplayPlan,
} from './resolveConnectedServiceContinuationReplayPlan';

describe('resolveConnectedServiceContinuationReplayPlan', () => {
  it('suppresses continuation for pre-turn group policy switches', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'pre_turn_group_policy',
      hasProviderActivityThisTurn: false,
    })).toEqual({
      continuationRequired: false,
      replayMode: 'suppress',
    });
  });

  it('uses a continuation prompt when provider activity evidence is ambiguous after daemon-local state is lost', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      hasProviderActivityThisTurn: false,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('uses a continuation prompt when the interrupted turn lacks durable no-activity evidence', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      hasProviderActivityThisTurn: false,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('retries the original user message only when durable transcript evidence proves no provider activity', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      hasProviderActivityThisTurn: false,
      providerActivityEvidence: 'no_activity_found',
    })).toEqual({
      continuationRequired: true,
      replayMode: 'retry_original_user_message',
    });
  });

  it('uses a continuation prompt when durable transcript evidence found provider activity despite a missing daemon-local flag', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      hasProviderActivityThisTurn: false,
      providerActivityEvidence: 'activity_found',
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('uses a continuation prompt for a completed provider turn even after the daemon-local queue goes idle', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('uses a continuation prompt when the interrupted turn already had provider activity', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('suppresses continuation for a manual switch that did not interrupt a live turn (idle session)', () => {
    // Live regression 2026-07-10: a settings pool switch sent "continue" prompts to sessions that
    // were merely ACTIVE, not working. The daemon-local `hasProviderActivityThisTurn` flag is set on
    // task_started and survives the turn's end, so an idle session that ever completed a turn still
    // reads stale-true. A MANUAL switch is boundary-deferred by construction — it only interrupts
    // work when the deferral was FORCED mid-turn — so interruption must come from the live-turn
    // evidence, never from the stale activity flag or the durable transcript probe.
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'manual',
      turnInterrupted: false,
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: false,
      replayMode: 'suppress',
    });
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'manual',
      turnInterrupted: false,
      hasProviderActivityThisTurn: false,
      providerActivityEvidence: 'no_activity_found',
    })).toEqual({
      continuationRequired: false,
      replayMode: 'suppress',
    });
  });

  it('keeps the continuation for a manual switch that interrupted a live turn (forced boundary)', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'manual',
      turnInterrupted: true,
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('keeps evidence-driven continuation for failure switches even when no turn is in flight (failTurn closes the turn first)', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      switchReason: 'automatic_runtime_failure',
      turnInterrupted: false,
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('releases the old turn boundary for continuation and guarded original retry plans', () => {
    expect(shouldReleaseConnectedServiceRestartBoundaryForReplayPlan({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    })).toBe(true);
    expect(shouldReleaseConnectedServiceRestartBoundaryForReplayPlan({
      continuationRequired: true,
      replayMode: 'retry_original_user_message',
    })).toBe(true);
    expect(shouldReleaseConnectedServiceRestartBoundaryForReplayPlan({
      continuationRequired: false,
      replayMode: 'suppress',
    })).toBe(false);
  });
});

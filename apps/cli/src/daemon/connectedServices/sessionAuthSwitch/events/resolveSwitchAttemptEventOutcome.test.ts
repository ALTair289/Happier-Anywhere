import { describe, expect, it } from 'vitest';

import { resolveSwitchAttemptEventOutcomeForSuccess } from './resolveSwitchAttemptEventOutcome';

describe('resolveSwitchAttemptEventOutcomeForSuccess', () => {
  it('projects a restart request as observed until supervision proves replacement adoption', () => {
    expect(resolveSwitchAttemptEventOutcomeForSuccess({ action: 'restart_requested' })).toEqual({
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'observed',
      outcomeAction: 'none',
    });
  });
});

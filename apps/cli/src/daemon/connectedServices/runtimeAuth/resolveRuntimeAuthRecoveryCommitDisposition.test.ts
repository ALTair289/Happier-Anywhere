import { describe, expect, it } from 'vitest';

import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from './reportConnectedServiceRuntimeAuthFailureToDaemon';
import { isCommittedRuntimeAuthRecoveryDisposition } from './resolveRuntimeAuthRecoveryCommitDisposition';

function outcome(input: Partial<ConnectedServiceRuntimeAuthFailureDaemonReport>): ConnectedServiceRuntimeAuthFailureDaemonReport {
  return {
    handled: false,
    report: null,
    statusCode: null,
    statusMessage: null,
    ...input,
  };
}

describe('isCommittedRuntimeAuthRecoveryDisposition', () => {
  it.each([
    null,
    { ok: true, result: { status: 'recovery_retry_scheduled' } },
    { ok: true, result: { status: 'recovery_handler_failed' } },
    { ok: true, result: { status: 'daemon_lifecycle_unavailable' } },
    { ok: true, result: { status: 'action_required' } },
    { result: { status: 'recovery_action_required' } },
    { ok: false, result: { status: 'recovery_action_required' } },
  ])('retains the caller intent for an uncommitted or ambiguous report %#', (report) => {
    expect(isCommittedRuntimeAuthRecoveryDisposition(outcome({ handled: true, report }))).toBe(false);
  });

  it.each([
    { ok: true, result: { status: 'recovery_action_required' } },
    { ok: true, result: { status: 'switch_attempted', result: { status: 'switched' } } },
    { ok: true, result: { status: 'switch_attempted', result: { status: 'observed_generation' } } },
  ])('accepts an explicit committed daemon result %#', (report) => {
    expect(isCommittedRuntimeAuthRecoveryDisposition(outcome({ report }))).toBe(true);
  });

  it.each(['recovered', 'terminal'] as const)(
    'accepts an explicit %s durable recovery receipt independent of presentation handling',
    (transition) => {
      expect(isCommittedRuntimeAuthRecoveryDisposition(outcome({
        recoveryReceipt: {
          reportId: 'runtime-auth-report:stable',
          attemptId: 'attempt-stable',
          transition,
          eventLocalId: `runtime-auth-recovery:attempt-stable:${transition}`,
        },
      }))).toBe(true);
    },
  );
});

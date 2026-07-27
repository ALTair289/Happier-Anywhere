import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from './reportConnectedServiceRuntimeAuthFailureToDaemon';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * Whether the daemon report explicitly committed a disposition that supersedes
 * the caller's older recovery intent. Presentation/projection `handled` state is
 * deliberately irrelevant: it describes emitted UX, not durable settlement.
 */
export function isCommittedRuntimeAuthRecoveryDisposition(
  outcome: ConnectedServiceRuntimeAuthFailureDaemonReport,
): boolean {
  const receiptTransition = outcome.recoveryReceipt?.transition;
  if (receiptTransition === 'recovered' || receiptTransition === 'terminal') return true;

  const envelope = readRecord(outcome.report);
  if (envelope?.ok !== true) return false;
  const result = readRecord(envelope.result);
  if (!result) return false;
  if (result.status === 'recovery_action_required') return true;
  if (result.status !== 'switch_attempted') return false;
  const switchResult = readRecord(result.result);
  return switchResult?.status === 'switched' || switchResult?.status === 'observed_generation';
}

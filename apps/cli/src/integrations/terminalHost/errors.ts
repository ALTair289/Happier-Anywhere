import type { TerminalHostKind } from './_types';

export type TerminalHostStartupFailureReason =
  | 'startup_action_timeout'
  | 'startup_action_failed'
  | 'recovery_probe_inconclusive'
  | 'live_attachment_adoption_unavailable'
  | 'bootstrap_cleanup_did_not_converge'
  | 'pane_disappeared_after_bootstrap_cleanup';

export type TerminalHostStartupErrorParams = Readonly<{
  hostKind: TerminalHostKind;
  reason: TerminalHostStartupFailureReason;
  message: string;
  diagnostics?: Readonly<Record<string, unknown>> | undefined;
}>;

export class TerminalHostStartupError extends Error {
  readonly code = 'terminal_host_startup_failed';
  readonly hostKind: TerminalHostKind;
  readonly reason: TerminalHostStartupFailureReason;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;

  constructor(params: TerminalHostStartupErrorParams) {
    super(params.message);
    this.name = 'TerminalHostStartupError';
    this.hostKind = params.hostKind;
    this.reason = params.reason;
    this.diagnostics = params.diagnostics;
  }
}

export function isTerminalHostStartupError(error: unknown): error is TerminalHostStartupError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<TerminalHostStartupError>;
  return candidate.code === 'terminal_host_startup_failed'
    && typeof candidate.hostKind === 'string'
    && typeof candidate.reason === 'string';
}

export function isRecoveryProbeInconclusiveError(error: unknown): error is TerminalHostStartupError {
  return isTerminalHostStartupError(error) && error.reason === 'recovery_probe_inconclusive';
}

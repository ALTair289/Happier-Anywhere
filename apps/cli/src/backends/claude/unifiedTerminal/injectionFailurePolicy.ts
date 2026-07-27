import type { TerminalInputInjectionResult } from '@/agent/runtime/terminal/_types';

export type ClaudeUnifiedInjectionFailureAction =
  | Readonly<{ kind: 'retry'; retryAfterMs: number }>
  | Readonly<{ kind: 'await_provider_confirmation' }>
  | Readonly<{ kind: 'terminal_failure' }>;

export function classifyClaudeUnifiedInjectionFailure(
  failure: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  opts: Readonly<{
    retryAttempt: number;
    retryLimit: number;
    retryBaseDelayMs: number;
  }>,
): ClaudeUnifiedInjectionFailureAction {
  if (!failure.recoverable) {
    return { kind: 'terminal_failure' };
  }

  if (failure.duplicateRisk !== 'none') {
    return { kind: 'await_provider_confirmation' };
  }

  if (opts.retryAttempt >= opts.retryLimit) {
    return { kind: 'terminal_failure' };
  }

  const retryAfterMs = Math.max(0, Math.trunc(opts.retryBaseDelayMs * 2 ** opts.retryAttempt));
  return { kind: 'retry', retryAfterMs };
}

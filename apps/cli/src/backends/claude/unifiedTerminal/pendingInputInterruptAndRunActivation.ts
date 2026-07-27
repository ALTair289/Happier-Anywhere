import type { TerminalHostKind } from '@/integrations/terminalHost/_types';

/**
 * Provider-owned activation policy. tmux is enabled by the current real-Claude queue/escape probe;
 * zellij remains fail-closed until the same contract is proven on a live Linux host.
 */
export function isClaudeUnifiedPendingInputInterruptAndRunEnabled(
  hostKind: TerminalHostKind,
): boolean {
  return hostKind === 'tmux';
}

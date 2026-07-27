import type { TerminalInputState } from '@/integrations/terminalHost/_types';

import {
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from './tuiControls/screenState';

export type ClaudeUnifiedQueuedPromptInterruptResult =
  | Readonly<{ ok: true; status: 'interrupted' }>
  | Readonly<{
    ok: false;
    status: 'stale_state' | 'not_safe' | 'capture_unavailable' | 'interrupt_failed';
    error?: string;
  }>;

/**
 * Executes the provider-owned post-custody control. The capture is deliberately fresh and the
 * one-shot arbiter claim happens only after screen proof, immediately before the sole Escape.
 */
export async function interruptClaudeUnifiedQueuedPrompt(opts: Readonly<{
  localId: string;
  readCurrentLocalId: () => string | null;
  claim: (localId: string) => boolean;
  captureInputState: () => Promise<TerminalInputState>;
  interruptTurn: () => Promise<void>;
}>): Promise<ClaudeUnifiedQueuedPromptInterruptResult> {
  if (opts.readCurrentLocalId() !== opts.localId) {
    return { ok: false, status: 'stale_state' };
  }

  let inputState: TerminalInputState;
  try {
    inputState = await opts.captureInputState();
  } catch {
    return { ok: false, status: 'capture_unavailable' };
  }

  const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
  if (
    !screen.queuedMessageBannerVisible
    || resolveClaudeScreenInFlightSteerVeto(screen) !== null
  ) {
    return { ok: false, status: 'not_safe' };
  }

  if (!opts.claim(opts.localId)) {
    return { ok: false, status: 'stale_state' };
  }

  try {
    await opts.interruptTurn();
    return { ok: true, status: 'interrupted' };
  } catch {
    return { ok: false, status: 'interrupt_failed' };
  }
}

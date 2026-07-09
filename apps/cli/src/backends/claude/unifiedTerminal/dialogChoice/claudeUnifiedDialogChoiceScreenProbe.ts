import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';
import { logger } from '@/ui/logger';

import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
} from '../tuiControls/controlRuntime';
import {
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedDialogId,
  type ClaudeUnifiedVisibleDialog,
} from '../tuiControls/dialogRegistry';
import type { ClaudeScreenState } from '../tuiControls/screenState';
import type {
  ClaudeUnifiedDialogChoiceBroker,
  ClaudeUnifiedDialogChoiceDecision,
} from './claudeUnifiedDialogChoiceBroker';

export type ClaudeUnifiedDialogChoiceScreenProbeResult =
  | Readonly<{ kind: 'request_published'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'already_pending'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'owned'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'not_visible' }>
  | Readonly<{ kind: 'failed'; reason: string }>
  | Readonly<{ kind: 'unsupported'; reason?: string | undefined }>;

export type ClaudeUnifiedDialogChoiceScreenProbe = Readonly<{
  probe: () => Promise<ClaudeUnifiedDialogChoiceScreenProbeResult>;
  evaluateScreenState: (state: ClaudeScreenState) => Promise<ClaudeUnifiedDialogChoiceScreenProbeResult>;
  dispose: () => void;
}>;

function captureFailureResult(
  captured: Awaited<ReturnType<typeof captureScreenState>>,
): ClaudeUnifiedDialogChoiceScreenProbeResult | null {
  if (captured.kind === 'state') return null;
  const failure = captureFailureToResult(captured);
  if (failure?.kind === 'unsupported') return { kind: 'unsupported', reason: failure.reason };
  return { kind: 'failed', reason: failure?.kind ?? 'capture_failed' };
}

async function answerClaudeUnifiedDialogChoice(params: Readonly<{
  port: TerminalControlPort;
  decision: ClaudeUnifiedDialogChoiceDecision;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
}>): Promise<'answered' | 'not_visible' | 'failed'> {
  if (params.decision.dialogId === 'unrecognized_confirmation') return 'answered';
  const before = await captureScreenState(params.port);
  if (before.kind !== 'state') return 'failed';
  const dialog = resolveClaudeUnifiedVisibleDialog(before.state);
  if (dialog?.kind !== 'recognized' || dialog.dialogId !== params.decision.dialogId) return 'not_visible';
  const selected = dialog.options.find((option) => option.choice === params.decision.choice);
  if (!selected) return 'failed';

  const literalFailure = sendResultToFailure(await params.port.sendLiteralText(selected.answer.text));
  if (literalFailure) return 'failed';
  const enterFailure = sendResultToFailure(await params.port.sendSpecialKey('Enter'));
  if (enterFailure) return 'failed';

  await params.wait(params.settleMs);
  const after = await captureScreenState(params.port);
  if (after.kind !== 'state') return 'failed';
  const remaining = resolveClaudeUnifiedVisibleDialog(after.state);
  return remaining?.dialogId === params.decision.dialogId ? 'failed' : 'answered';
}

export function createClaudeUnifiedDialogChoiceScreenProbe(params: Readonly<{
  broker: ClaudeUnifiedDialogChoiceBroker;
  port: TerminalControlPort;
  wait: (ms: number) => Promise<void>;
  graceMs: number;
  settleMs: number;
  isDialogOwned: (dialogId: ClaudeUnifiedDialogId) => boolean;
}>): ClaudeUnifiedDialogChoiceScreenProbe {
  let disposed = false;
  let answerTask: Promise<void> | null = null;
  let answerTaskDialogId: ClaudeUnifiedDialogId | null = null;
  let abortController: AbortController | null = null;

  const dialogIsOwned = (dialog: ClaudeUnifiedVisibleDialog): boolean => (
    dialog.owner !== null && params.isDialogOwned(dialog.dialogId)
  );

  const cancelPendingIfResolved = (): void => {
    if (params.broker.hasPendingChoice()) {
      params.broker.noteDialogResolvedInTerminal('claude_dialog_resolved_in_terminal');
    }
  };

  const startAnswerTask = (dialog: ClaudeUnifiedVisibleDialog): boolean => {
    if (answerTask && answerTaskDialogId === dialog.dialogId) return false;
    if (answerTask) {
      abortController?.abort('claude_unified_dialog_changed');
      params.broker.cancelPendingChoice('claude_unified_dialog_changed');
    }
    const taskAbortController = new AbortController();
    abortController = taskAbortController;
    params.broker.activate();
    const signal = taskAbortController.signal;
    const task = params.broker.requestDialogChoice({ dialog, signal })
      .then(async (decision) => {
        if (disposed) return;
        const result = await answerClaudeUnifiedDialogChoice({
          port: params.port,
          decision,
          wait: params.wait,
          settleMs: params.settleMs,
        });
        if (result === 'not_visible') {
          params.broker.noteDialogResolvedInTerminal('claude_dialog_resolved_in_terminal');
        } else if (result === 'failed') {
          logger.debug('[unified]: failed to answer Claude unified terminal dialog', {
            dialogId: decision.dialogId,
          });
        }
      })
      .catch((error) => {
        if (!disposed) logger.debug('[unified]: Claude dialog choice request ended without an answer', error);
      })
      .finally(() => {
        if (answerTask === task) {
          answerTask = null;
          answerTaskDialogId = null;
          abortController = null;
        }
      });
    answerTask = task;
    answerTaskDialogId = dialog.dialogId;
    return true;
  };

  const evaluateScreenState = async (
    state: ClaudeScreenState,
  ): Promise<ClaudeUnifiedDialogChoiceScreenProbeResult> => {
    if (disposed) return { kind: 'failed', reason: 'disposed' };
    const initialDialog = resolveClaudeUnifiedVisibleDialog(state);
    if (!initialDialog) {
      cancelPendingIfResolved();
      return { kind: 'not_visible' };
    }
    if (dialogIsOwned(initialDialog)) {
      return { kind: 'owned', dialogId: initialDialog.dialogId };
    }

    await params.wait(Math.max(0, params.graceMs));
    if (disposed) return { kind: 'failed', reason: 'disposed' };
    const recaptured = await captureScreenState(params.port);
    const failure = captureFailureResult(recaptured);
    if (failure) return failure;
    if (recaptured.kind !== 'state') return { kind: 'failed', reason: 'capture_failed' };
    const dialog = resolveClaudeUnifiedVisibleDialog(recaptured.state);
    if (!dialog) {
      cancelPendingIfResolved();
      return { kind: 'not_visible' };
    }
    if (dialogIsOwned(dialog)) {
      return { kind: 'owned', dialogId: dialog.dialogId };
    }

    const alreadyPending = params.broker.hasPendingChoice(dialog.dialogId)
      && answerTaskDialogId === dialog.dialogId;
    const started = startAnswerTask(dialog);
    return {
      kind: alreadyPending || !started ? 'already_pending' : 'request_published',
      dialogId: dialog.dialogId,
    };
  };

  return {
    async probe() {
      if (disposed) return { kind: 'failed', reason: 'disposed' };
      const captured = await captureScreenState(params.port);
      const failure = captureFailureResult(captured);
      if (failure) return failure;
      if (captured.kind !== 'state') return { kind: 'failed', reason: 'capture_failed' };
      return evaluateScreenState(captured.state);
    },
    evaluateScreenState,
    dispose() {
      if (disposed) return;
      disposed = true;
      abortController?.abort('claude_unified_dialog_choice_screen_probe_disposed');
      abortController = null;
      answerTask = null;
      answerTaskDialogId = null;
    },
  };
}

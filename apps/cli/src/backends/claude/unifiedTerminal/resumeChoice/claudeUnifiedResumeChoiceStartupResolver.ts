import type { ClaudeUnifiedTerminalResumeChoice } from '@happier-dev/agents';
import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import type { EnhancedMode } from '../../loop';
import { mapEnhancedModeToDesiredRuntimeConfig } from '../runtimeControlIntegration';
import type { ClaudeUnifiedStartupDialogResolver } from '../createClaudeUnifiedTerminalReadinessBridge';
import {
  answerClaudeResumeChoiceDialog,
  type ClaudeUnifiedResumeChoiceAnswer,
} from '../tuiControls/resumeChoice';
import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
} from '../tuiControls/controlRuntime';
import type { ClaudeUnifiedResumeChoiceBroker } from './claudeUnifiedResumeChoiceBroker';

const MAX_STARTUP_DIALOG_ANSWER_ATTEMPTS = 2;

type StartupDialogKind = 'effort_change' | 'switch_model';

type StartupDialogAnswerResult =
  | Readonly<{ kind: 'answered'; stateVisibleAfterAnswer: boolean }>
  | Readonly<{ kind: 'not_visible' }>
  | Readonly<{ kind: 'failed'; reason: string }>
  | Readonly<{ kind: 'unsupported'; reason?: string | undefined }>;

function controlFailureToStartupDialogResult(
  failure: ReturnType<typeof sendResultToFailure> | ReturnType<typeof captureFailureToResult>,
): StartupDialogAnswerResult | null {
  if (failure === null) return null;
  if (failure.kind === 'unsupported') return { kind: 'unsupported', reason: failure.reason };
  const reason = 'reason' in failure && typeof failure.reason === 'string'
    ? failure.reason
    : failure.kind;
  return { kind: 'failed', reason };
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfiguredEffortTargets(startupMode: EnhancedMode | undefined): readonly string[] {
  if (!startupMode) return [];
  const desired = mapEnhancedModeToDesiredRuntimeConfig(startupMode);
  if (desired.ultracode === true) return ['ultracode', 'xhigh'];
  const effort = normalizeNonEmptyString(desired.reasoningEffort);
  return effort ? [effort] : [];
}

function hasConfiguredModel(startupMode: EnhancedMode | undefined): boolean {
  if (!startupMode) return false;
  return normalizeNonEmptyString(mapEnhancedModeToDesiredRuntimeConfig(startupMode).model) !== null;
}

async function answerStartupDialogOption(params: Readonly<{
  port: TerminalControlPort;
  kind: StartupDialogKind;
  option: '1' | '2';
  wait: (ms: number) => Promise<void>;
  settleMs: number;
}>): Promise<StartupDialogAnswerResult> {
  const before = await captureScreenState(params.port);
  if (before.kind !== 'state') {
    return controlFailureToStartupDialogResult(captureFailureToResult(before)) ?? { kind: 'failed', reason: 'capture_failed' };
  }
  const visibleBefore = params.kind === 'effort_change'
    ? before.state.effortChangeDialogVisible
    : before.state.switchModelDialogVisible;
  if (!visibleBefore) return { kind: 'not_visible' };

  const sendOptionFailure = controlFailureToStartupDialogResult(
    sendResultToFailure(await params.port.sendLiteralText(params.option)),
  );
  if (sendOptionFailure) return sendOptionFailure;

  const sendEnterFailure = controlFailureToStartupDialogResult(
    sendResultToFailure(await params.port.sendSpecialKey('Enter')),
  );
  if (sendEnterFailure) return sendEnterFailure;

  await params.wait(params.settleMs);
  const after = await captureScreenState(params.port);
  if (after.kind !== 'state') {
    return controlFailureToStartupDialogResult(captureFailureToResult(after)) ?? { kind: 'failed', reason: 'capture_failed' };
  }
  const visibleAfter = params.kind === 'effort_change'
    ? after.state.effortChangeDialogVisible
    : after.state.switchModelDialogVisible;
  return { kind: 'answered', stateVisibleAfterAnswer: visibleAfter };
}

export function createClaudeUnifiedResumeChoiceStartupResolver(params: Readonly<{
  choice: ClaudeUnifiedTerminalResumeChoice;
  broker: ClaudeUnifiedResumeChoiceBroker;
  port: TerminalControlPort;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
  startupMode?: EnhancedMode | undefined;
  isRuntimeControlInFlight?: (() => boolean) | undefined;
}>): ClaudeUnifiedStartupDialogResolver {
  let pendingAnswerTask: Promise<void> | null = null;
  let terminalAnswerInFlight = false;
  let autoAnswerFailed = false;
  let userChoiceClosed = false;
  const startupDialogAnswerAttempts = new Map<StartupDialogKind, number>();

  const answerOrphanStartupDialog = async (
    kind: StartupDialogKind,
    option: '1' | '2',
  ): Promise<Readonly<{ status: 'handled' | 'unhandled' }>> => {
    const attempts = startupDialogAnswerAttempts.get(kind) ?? 0;
    if (attempts >= MAX_STARTUP_DIALOG_ANSWER_ATTEMPTS) {
      return { status: 'unhandled' };
    }
    const result = await answerStartupDialogOption({
      port: params.port,
      kind,
      option,
      wait: params.wait,
      settleMs: params.settleMs,
    });
    if (result.kind === 'not_visible' || (result.kind === 'answered' && !result.stateVisibleAfterAnswer)) {
      startupDialogAnswerAttempts.delete(kind);
      return { status: 'handled' };
    }
    startupDialogAnswerAttempts.set(kind, attempts + 1);
    return attempts + 1 >= MAX_STARTUP_DIALOG_ANSWER_ATTEMPTS
      ? { status: 'unhandled' }
      : { status: 'handled' };
  };

  const startUserChoice = (signal: AbortSignal): void => {
    params.broker.activate();
    if (userChoiceClosed || params.broker.hasPendingChoice() || pendingAnswerTask) return;
    pendingAnswerTask = params.broker.requestResumeChoice({ signal })
      .then(async (choice: ClaudeUnifiedResumeChoiceAnswer) => {
        terminalAnswerInFlight = true;
        const result = await answerClaudeResumeChoiceDialog({
          port: params.port,
          choice,
          wait: params.wait,
          settleMs: params.settleMs,
        }).finally(() => {
          terminalAnswerInFlight = false;
        });
        if (result.kind !== 'answered' && result.kind !== 'not_visible') {
          userChoiceClosed = true;
        }
      })
      .catch(() => {
        userChoiceClosed = true;
      })
      .finally(() => {
        pendingAnswerTask = null;
      });
  };

  return async ({ screenState, abortSignal }) => {
    if (params.isRuntimeControlInFlight?.() !== true) {
      if (screenState.effortChangeDialogVisible) {
        const targets = resolveConfiguredEffortTargets(params.startupMode);
        const option = screenState.effortChangeDialogTarget !== null
          && targets.includes(screenState.effortChangeDialogTarget)
          ? '1'
          : '2';
        return answerOrphanStartupDialog('effort_change', option);
      }
      if (screenState.switchModelDialogVisible) {
        return answerOrphanStartupDialog('switch_model', hasConfiguredModel(params.startupMode) ? '1' : '2');
      }
    }

    if (!screenState.resumeChoiceDialogVisible) {
      if (params.broker.hasPendingChoice()) {
        params.broker.noteDialogResolvedInTerminal('resume_dialog_resolved_in_terminal');
        return { status: 'handled' };
      }
      return pendingAnswerTask ? { status: 'waiting_for_user' } : { status: 'unhandled' };
    }

    if (params.choice === 'ask_every_time') {
      if (userChoiceClosed) {
        return { status: 'unhandled' };
      }
      startUserChoice(abortSignal);
      return params.broker.hasPendingChoice() || terminalAnswerInFlight
        ? { status: 'waiting_for_user' }
        : { status: 'unhandled' };
    }

    if (autoAnswerFailed) {
      return { status: 'unhandled' };
    }

    const result = await answerClaudeResumeChoiceDialog({
      port: params.port,
      choice: params.choice,
      wait: params.wait,
      settleMs: params.settleMs,
    });

    if (result.kind === 'answered' || result.kind === 'not_visible') {
      return { status: 'handled' };
    }
    autoAnswerFailed = true;
    return { status: 'unhandled' };
  };
}

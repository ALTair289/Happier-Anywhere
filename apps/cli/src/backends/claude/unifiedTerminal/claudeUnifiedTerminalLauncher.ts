import { createClaudeReadyHandler } from '../ready/createClaudeReadyHandler';
import { createClaudePendingAwareInputConsumer } from '../createClaudePendingAwareInputConsumer';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { EnhancedMode } from '../loop';
import type { Session } from '../session';
import type { LauncherResult } from '../claudeLocalLauncher';
import { createClaudeSessionTranscriptProjector } from '../localControl/createClaudeSessionTranscriptProjector';
import { createClaudeWorkflowActivitySourceForSession } from '../workflows/createClaudeWorkflowActivitySourceForSession';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { adoptClaudePermissionModeFromMetadata } from '../utils/syncPermissionModeFromMetadata';
import {
  isClaudeRuntimeAuthFailureOwnedByDaemonRecovery,
  surfaceClaudeRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from '../connectedServices/surfaceClaudeRuntimeIssues';
import { createClaudeInFlightSteerCapabilityPublisher } from './createClaudeInFlightSteerCapabilityPublisher';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import type { ClaudeUnifiedTerminalScreenObservation } from './_types';
import { readDaemonInitialGoalFromEnv } from '@/agent/runtime/sessionInitialGoal';
import { isClaudeUnifiedTerminalManagedSettingsOptionError } from './buildClaudeUnifiedTerminalSpawn';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID, DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './tuiControls';
import { ClaudeUnifiedResumeChoiceBroker } from './resumeChoice/claudeUnifiedResumeChoiceBroker';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './resumeChoice/claudeUnifiedResumeChoiceStartupResolver';
import { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';
import type {
  ClaudeUnifiedRuntimeConfigOutcomeEvent,
  ClaudeUnifiedRuntimeControlApplyResult,
} from './runtimeControlIntegration';
import {
  buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
  isClaudeUnifiedRuntimeControlUserDraftBlocker,
} from './runtimeControlIntegration';
import { createUnifiedTerminalGateOffRestartNoticeTracker } from './runtimeConfigRestartNotice';
import { createClaudeUnifiedTerminalMetadataModeApplier } from './metadataRuntimeModeApplier';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { bindClaudeUnifiedTerminalSession } from './bindClaudeUnifiedTerminalSession';
import { createTerminalComposerDraftBlockedEvent } from './terminalComposerDraftBlockedEvent';
import { isClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import { isClaudeUnifiedTerminalReadinessTimeoutError } from './createClaudeUnifiedTerminalReadinessBridge';
import {
  isClaudeUnifiedTerminalRuntimeIssueError,
  surfaceClaudeUnifiedTerminalRuntimeIssue,
} from './surfaceClaudeUnifiedTerminalRuntimeIssue';
import {
  createClaudeUnifiedTerminalUnobservedFailedTurnError,
  isClaudeUnifiedTerminalAmbiguousInjectionFailureError,
  isClaudeUnifiedTerminalRecoverableProviderAcceptanceUnknownFailure,
} from './terminalInjectionFailureError';
import {
  resolveClaudeUnifiedProviderUnavailableUntilMs,
  resolveClaudeUnifiedProviderUnavailableWindowForUsageLimitDialog,
  type ClaudeUnifiedProviderUnavailablePromptDeliveryWindow,
} from './pendingDeliveryBlock';
import {
  createClaudeUnifiedSustainedPendingDeliveryBlockHandler,
  handleClaudeUnifiedTerminalRuntimeIssuePendingDeliveryBlock,
} from './claudeUnifiedPendingDeliveryBlockHandling';
import { normalizePendingDeliveryLocalIds, returnOrBlockUndeliverableProviderPrompt } from '@/agent/runtime/session/pendingDelivery/undeliverableProviderPrompt';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { isTerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { runTmuxAttach } from '@/terminal/attachment/tmuxAttach';
import { runZellijAttach } from '@/terminal/attachment/zellijAttach';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';
import { extractClaudeTerminalInitialPrompt } from '../cli/terminalInitialPrompt';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { configuration } from '@/configuration';
import { delay } from '@/utils/time';
import { readClaudeActiveUnifiedTerminalHost } from '../utils/readClaudeActiveTerminalMode';

function shouldForegroundAttachTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS = 5_000;

type ParkedUnifiedTerminalMessage = Readonly<{
  message: string;
  mode: EnhancedMode;
  maxUserMessageSeq: number | null;
  userMessageLocalIds: readonly string[];
}>;

type InFlightStartupMessage = Readonly<{
  source: 'initial' | 'parked' | 'queue';
  batch: ParkedUnifiedTerminalMessage;
}>;

function buildClaudeRecoveryResumeArgs(
  claudeArgs: readonly string[],
  sessionId: string | null,
): readonly string[] {
  if (!sessionId) return claudeArgs;
  const argsWithoutPreviousResume: string[] = [];
  for (let index = 0; index < claudeArgs.length; index += 1) {
    const arg = claudeArgs[index];
    if (arg === '--continue' || arg === '-c') continue;
    if (arg === '--resume' || arg === '-r') {
      const next = claudeArgs[index + 1];
      if (typeof next === 'string' && !next.startsWith('-')) index += 1;
      continue;
    }
    if (arg === '--session-id') {
      const next = claudeArgs[index + 1];
      if (typeof next === 'string' && !next.startsWith('-')) index += 1;
      continue;
    }
    if (arg === '--fork-session') continue;
    if (arg.startsWith('--resume=') || arg.startsWith('-r=')) continue;
    if (arg.startsWith('--session-id=') || arg.startsWith('--fork-session=')) continue;
    argsWithoutPreviousResume.push(arg);
  }
  return [...argsWithoutPreviousResume, '--resume', sessionId];
}

function areSameUserMessageLocalIds(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  const rhs = b ?? [];
  if (a.length !== rhs.length) return false;
  return a.every((value, index) => value === rhs[index]);
}

function isInvalidPromptTextInjectionFailure(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_injection_failed'
    && (error as { failureState?: unknown }).failureState === 'failed_terminal'
    && (error as { reason?: unknown }).reason === 'invalid_prompt_text'
    && (error as { phase?: unknown }).phase === 'before_write'
    && (error as { duplicateRisk?: unknown }).duplicateRisk === 'none'
    && (error as { recoverable?: unknown }).recoverable === false;
}

function startForegroundAttach(params: Readonly<{
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}>): void {
  if (!shouldForegroundAttachTerminal()) return;

  if (params.terminal.mode === 'tmux') {
    void runTmuxAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
    return;
  }

  if (params.terminal.mode === 'zellij') {
    void runZellijAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
  }
}

function sendUnifiedTerminalHostDeadMessage(
  session: Session,
  params: Readonly<{ promptDeliveryWasPending: boolean }>,
): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: params.promptDeliveryWasPending
      ? 'Claude unified terminal host is not alive. The terminal process exited before Happier could send your prompt.'
      : 'Claude unified terminal host is not alive. The terminal process exited.',
  });
}

function sendUnifiedTerminalDeliveryUnknownMessage(session: Session): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: 'Claude could not confirm whether your queued message reached the terminal. Happier stopped automatic retry to avoid sending the same prompt twice; send a new message or restart the session when you are ready.',
  });
}

function isRecentClaudeUnifiedTerminalAuthFailure(params: Readonly<{
  authFailureAtMs: number | null;
  nowMs: number;
}>): boolean {
  return params.authFailureAtMs !== null
    && params.nowMs - params.authFailureAtMs >= 0
    && params.nowMs - params.authFailureAtMs <= CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS;
}

async function flushUnifiedStartupFailureSurface(session: Session, reason: string): Promise<void> {
  try {
    await session.client.flush();
  } catch (error) {
    logger.debug('[unified]: failed to flush Claude unified startup failure surface (non-fatal)', {
      reason,
      error,
    });
  }
}

function asStandaloneUnifiedMode(mode: EnhancedMode): EnhancedMode {
  return {
    ...mode,
    claudeUnifiedTerminalEnabled: true,
  };
}

function readActiveUnifiedTerminalHost(session: Session): 'tmux' | 'zellij' | null {
  return readClaudeActiveUnifiedTerminalHost({
    terminalRuntime: session.terminalRuntime,
    metadata: session.client.getMetadataSnapshot?.(),
  });
}

function applyActiveTerminalHostToStartupMode(session: Session, mode: EnhancedMode): EnhancedMode {
  const activeHost = readActiveUnifiedTerminalHost(session);
  if (!activeHost) return mode;
  if (mode.claudeUnifiedTerminalHost === activeHost) return mode;
  return {
    ...mode,
    claudeUnifiedTerminalHost: activeHost,
  };
}

function resolveCurrentRuntimeModeForActiveTerminalRuntime(session: Session, mode: EnhancedMode): EnhancedMode {
  return asStandaloneUnifiedMode(applyActiveTerminalHostToStartupMode(session, mode));
}

export async function claudeUnifiedTerminalLauncher(
  session: Session,
  opts: Readonly<{
    initialMode?: EnhancedMode | undefined;
    adoptExistingTerminalHost?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<LauncherResult> {
  const abortController = new AbortController();
  // Standalone/local Unified gets the SAME runtime-control integration as remote Unified (gap 26).
  const tuiRuntimeControlEnabled = resolveCliFeatureDecision({
    featureId: CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
    env: process.env,
  }).state === 'enabled';
  // QA-B B6 (live 2026-06-12, session cmqawdqzj): with the gate OFF the standalone launcher had no
  // legacy restart-notice path — runtime-config changes between turns were silently dropped. The
  // daemon launcher surfaces these notices at its mode boundary; the standalone launcher observes
  // each outgoing batch mode instead (one notice per distinct change signature).
  const gateOffRestartNoticeTracker = tuiRuntimeControlEnabled
    ? null
    : createUnifiedTerminalGateOffRestartNoticeTracker({
        emit: (emission) => {
          session.client.sendSessionEvent({ type: 'message', message: emission.message });
          session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent({
            status: emission.status,
            reason: emission.reason,
            message: emission.message,
            changes: emission.changes,
          }));
        },
      });
  const normalizeStartupMode = (mode: EnhancedMode): EnhancedMode =>
    applyActiveTerminalHostToStartupMode(session, mode);
  let currentRuntimeMode: EnhancedMode | null = opts.initialMode
    ? resolveCurrentRuntimeModeForActiveTerminalRuntime(session, opts.initialMode)
    : null;
  let applyUnifiedTerminalMetadataMode: ((mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>) | null = null;
  const applyUnifiedTerminalPermissionMetadata = createClaudeUnifiedTerminalMetadataModeApplier({
    getCurrentMode: () => currentRuntimeMode,
    getApplier: () => applyUnifiedTerminalMetadataMode,
  });
  const observeOutgoingBatchMode = (mode: EnhancedMode): EnhancedMode => {
    const nextMode = normalizeStartupMode(mode);
    currentRuntimeMode = asStandaloneUnifiedMode(nextMode);
    gateOffRestartNoticeTracker?.observeBatchMode(nextMode);
    return nextMode;
  };
  let removeExternalAbortListener: (() => void) | null = null;
  if (opts.signal) {
    const abortFromExternalSignal = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(opts.signal?.reason ?? 'claude-unified-external-abort');
      }
    };
    if (opts.signal.aborted) {
      abortFromExternalSignal();
    } else {
      opts.signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      removeExternalAbortListener = () => opts.signal?.removeEventListener('abort', abortFromExternalSignal);
    }
  }
  let turnInterrupt: (() => Promise<void>) | null = null;
  const initialPrompt = extractClaudeTerminalInitialPrompt(session.claudeArgs);
  let initialPromptPending = typeof initialPrompt.prompt === 'string';
  // Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4). Built at the launcher
  // (which owns credentials + stored-content encryption) and handed to the projector, which feeds it
  // the SAME raw transcript channel as the goal source and applies its CWF4 owned-id filter at the
  // work-state merge chokepoint. Null when no credentials are available yet — the goal / work-state
  // path is unaffected.
  const workflowActivitySource = await createClaudeWorkflowActivitySourceForSession({
    session,
    logPrefix: '[unified]',
    getCurrentClaudeSessionId: () => {
      const claudeSessionId = session.client.getMetadataSnapshot?.()?.claudeSessionId;
      return typeof claudeSessionId === 'string' && claudeSessionId.trim().length > 0 ? claudeSessionId.trim() : null;
    },
  });
  const transcriptProjector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[unified]', workflowActivitySource });
  let lastSurfacedRuntimeAuthFailureAtMs: number | null = null;
  let recentPrimaryProviderUnavailableForPromptDelivery: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null = null;
  let usageLimitDialogVisible = false;
  const readyHandler = createClaudeReadyHandler({
    session: session.client,
    pushSender: session.pushSender,
    waitingForCommandLabel: 'Claude',
    logPrefix: '[unified]',
    getPending: () => null,
    getQueueSize: () => session.queue.size(),
    accountSettings: session.accountSettings,
    settingsSecretsReadKeys: session.accountSettingsSecretsReadKeys,
    includeAssistantPreviewText:
      session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
    shouldSendPush: () => shouldSendReadyPushNotification(session.accountSettings ?? null),
  });
  const { mcpConfigJson } = await session.getOrCreateHappierMcpBridge();
  const binding = bindClaudeUnifiedTerminalSession({
    session: session.client,
    logPrefix: '[unified]',
    acceptedPromptEchoWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
    onMessage: (message) => {
      transcriptProjector.observe(message);
    },
    onReady: (context) => {
      readyHandler(context);
    },
    onTurnInterruptChanged: (handler) => {
      turnInterrupt = handler;
    },
    onPromptTurnStarted: () => {
      session.setThinkingWithoutTaskLifecycle(true);
    },
  });
  await binding.seedPersistedPromptEchoes();

  const recordPrimaryProviderUnavailableForPromptDelivery = (
    details: NormalizedProviderUsageLimitDetailsV1,
  ): void => {
    if (details.sourcedFromSidechain !== true) {
      const observedAtMs = Date.now();
      const unavailableUntilMs = resolveClaudeUnifiedProviderUnavailableUntilMs(details, observedAtMs);
      recentPrimaryProviderUnavailableForPromptDelivery = unavailableUntilMs === null
        ? null
        : { unavailableUntilMs };
    }
  };

  const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
    recordPrimaryProviderUnavailableForPromptDelivery(details);

    void surfaceClaudeRateLimitRuntimeIssue(session, details, '[unified]')
      .catch((error) => {
        logger.debug('[unified]: failed to surface Claude rate-limit runtime issue', error);
      })
      .finally(binding.notePromptTurnTerminal);
  }

  const surfacePromptTurnTerminal = async (event: Readonly<{
    reason: string;
    source: string;
    detail?: string | undefined;
    providerAcceptanceFailureObserved?: boolean | undefined;
  }>): Promise<void> => {
    if (event.reason === 'aborted') {
      await binding.recordPromptTurnCancelled();
      session.abortCurrentTaskTurn();
      return;
    }
    try {
      if (event.reason === 'failed' && event.source === 'claude_transcript_api_error') {
        await surfacePrimarySessionRuntimeIssue({
          provider: 'claude',
          cause: 'status_error',
          error: {
            code: event.source,
            message: event.detail ?? event.source,
          },
          session: session.client,
        }).catch((error) => {
          logger.debug('[unified]: failed to surface Claude transcript API-error turn failure (non-fatal)', error);
          return null;
        });
      } else if (event.reason === 'failed' && event.providerAcceptanceFailureObserved !== true) {
        await surfaceTerminalRuntimeIssue(createClaudeUnifiedTerminalUnobservedFailedTurnError());
      }
    } finally {
      // Any non-aborted terminal projection (hook StopFailure, process exit, unknown) must
      // terminalize the canonical turn; leaving it open keeps the server turn 'in_progress'
      // forever and permanently blocks daemon pending-queue draining (QA A-F3/C-F2).
      await binding.recordPromptTurnFailed().catch(() => undefined);
    }
  };
  const surfaceTerminalRuntimeIssue = async (
    error: unknown,
  ): Promise<
    | void
    | Readonly<{ action: 'claimed_pending_delivery' }>
    | Readonly<{ action: 'surfaced_runtime_issue' }>
  > => {
    const result = await handleClaudeUnifiedTerminalRuntimeIssuePendingDeliveryBlock({
      error,
      providerUnavailableWindow: recentPrimaryProviderUnavailableForPromptDelivery,
      setProviderUnavailableWindow: (window) => {
        recentPrimaryProviderUnavailableForPromptDelivery = window;
      },
      blockPendingMessageDelivery: session.client.blockPendingMessageDelivery?.bind(session.client),
      logPrefix: '[unified]',
      logDebug: (message, logError) => logger.debug(message, logError),
      deferAmbiguousRuntimeIssue: true,
      beforeSurfaceRuntimeIssue: () => session.onThinkingChange(false),
      surfaceRuntimeIssue: (runtimeIssueError) =>
        surfaceClaudeUnifiedTerminalRuntimeIssue({
          error: runtimeIssueError,
          session: session.client,
          onSurfaceError: (surfaceError) => {
            logger.debug('[unified]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
          },
        }).catch((surfaceError) => {
          logger.debug('[unified]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
          return null;
        }),
      onSurfacedRuntimeIssue: async () => {
        binding.notePromptTurnTerminal();
        await session.client.flush().catch((flushError) => {
          logger.debug('[unified]: failed to flush Claude unified terminal runtime issue surface (non-fatal)', flushError);
        });
      },
    });
    if (isClaudeUnifiedTerminalAmbiguousInjectionFailureError(error) && result === undefined) {
      logger.debug('[unified]: Claude unified terminal prompt delivery is ambiguous; waiting for confirmation or retry');
    }
    if (typeof result === 'boolean') {
      return result ? { action: 'surfaced_runtime_issue' } : undefined;
    }
    return result;
  };

  session.client.rpcHandlerManager.registerHandler('abort', async () => {
    session.noteUserAbortRequested();
    if (turnInterrupt) {
      try {
        await turnInterrupt();
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        return true;
      } catch (error) {
        logger.debug('[unified]: failed to interrupt Claude terminal turn; keeping unified host alive', error);
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        return true;
      }
    }
    logger.debug('[unified]: UI abort requested before Claude terminal turn interrupt handler was ready');
    await binding.recordPromptTurnCancelled();
    session.abortCurrentTaskTurn();
    return true;
  });

  // Lane P (O-design Seam A): publish live steer availability (+reason) to agentState.
  const inFlightSteerCapabilityPublisher = createClaudeInFlightSteerCapabilityPublisher({
    session: session.client,
    isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
  });
  const sustainedPendingDeliveryBlockHandler = createClaudeUnifiedSustainedPendingDeliveryBlockHandler({
    blockPendingMessageDelivery: session.client.blockPendingMessageDelivery?.bind(session.client),
    retryPendingMessageDelivery: session.client.retryPendingMessageDelivery?.bind(session.client),
    logPrefix: '[unified]',
    logDebug: (message, error) => logger.debug(message, error),
  });
  const observeTerminalScreen = (observation: ClaudeUnifiedTerminalScreenObservation): void => {
    if (observation.screenState.usageLimitDialogVisible) {
      recentPrimaryProviderUnavailableForPromptDelivery =
        resolveClaudeUnifiedProviderUnavailableWindowForUsageLimitDialog(Date.now());
      usageLimitDialogVisible = true;
      void sustainedPendingDeliveryBlockHandler.blockForSustainedBlocker({
        localIds: observation.userMessageLocalIds,
        blocker: {
          kind: 'provider_unavailable',
          source: 'readiness',
          detail: 'claude_usage_limit_dialog',
        },
        isCanonicalTurnActive: session.client.hasActiveCanonicalTurn?.() ?? true,
      });
      return;
    }
    if (!usageLimitDialogVisible) return;
    usageLimitDialogVisible = false;
    recentPrimaryProviderUnavailableForPromptDelivery = null;
    void sustainedPendingDeliveryBlockHandler.retryBlockedRowsOnce();
  };

  // Daemon-owned pending drain (QA C-F2/A-F3, live repro cmqb329qm044z): all idle input waits go
  // through the pending-aware consumer so server-side queued rows materialize on turn-end/idle
  // wakes. A raw `session.queue` wait only ever sees UI-RPC-delivered messages and strands queued
  // pending rows until a manual "Send now".
  const sessionInputConsumer = createClaudePendingAwareInputConsumer(session, {
    onMetadataUpdate: async () => {
      const updated = adoptClaudePermissionModeFromMetadata({ session });
      if (updated) {
        await applyUnifiedTerminalPermissionMetadata(updated.intent);
      }
    },
  });
  const resumeChoiceBroker = new ClaudeUnifiedResumeChoiceBroker(session);
  const dialogChoiceBroker = new ClaudeUnifiedDialogChoiceBroker(session);
  // A3-HIGH-1: this launcher confirms provider acceptance (runner onPromptAcceptedByProvider),
  // so the delivered-watermark must NOT advance at queue handoff anymore.
  session.client.deferDeliveredUserMessageWatermarkToProviderAcceptance?.();
  const waitForNextSessionInputBatch = async (): Promise<ParkedUnifiedTerminalMessage | null> => {
    try {
      const batch = await sessionInputConsumer.waitForNextInput({ abortSignal: abortController.signal });
      if (!batch) return null;
      return {
        message: batch.message,
        mode: batch.mode,
        maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch.userMessageLocalIds ?? [],
      };
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        // Classified terminal-auth stop: end the wait gracefully instead of escaping
        // into the generic fatal-command-error path (incident cmq7pyqkj family).
        logger.debug('[unified]: pending-queue materialization stopped after supervisor auth failure');
        return null;
      }
      throw error;
    }
  };

  // A classified unified runtime failure (injection failure, host death) must NEVER escape as a
  // process-killing `[claude] Fatal command error` (incident cmq7pyqkj: a mid-turn steer injection
  // hit its provider-acceptance timeout, the failed_terminal error was surfaced and then RETHROWN
  // out of this launcher, and loop.ts has no retry loop around it — the runner exited and the
  // session went dead). Instead the launcher parks: it surfaces the structured runtime issue,
  // waits for the next queued message, and relaunches the unified host with that message.
  let parkedMessage: ParkedUnifiedTerminalMessage | null = null;
  let inFlightStartupMessage: InFlightStartupMessage | null = null;
  let lastSurfacedRuntimeAuthFailureWasDaemonOwned = false;
  // A4-MED-3: bounded park/relaunch budget. The undeliverable-batch handback (F-1) re-pends a
  // terminally failed message, so a deterministically dying host would otherwise relaunch with
  // the SAME message forever. Any provider acceptance proves real progress and resets the budget.
  const MAX_CONSECUTIVE_PARK_RELAUNCHES = 3;
  let consecutiveParkRelaunches = 0;
  const consumeParkRelaunchBudget = (): 'within_budget' | 'exhausted' => {
    consecutiveParkRelaunches += 1;
    return consecutiveParkRelaunches <= MAX_CONSECUTIVE_PARK_RELAUNCHES ? 'within_budget' : 'exhausted';
  };
  // RC-RESUMEFLAP (live incident 2026-07-08, session cmr377jsr / runner pid 5526): four
  // deterministic host-startup failures burned this budget in ~50s and the exhaustion path
  // exited the runner with code 1 — a dead session the user had to resume manually, usually
  // hitting the same failure again (the resume flap). Durable server-owned rows make a better
  // terminal state available: BLOCK the poisoned rows (terminal_host_unreachable — manual
  // retry / a new message re-delivers them) and keep the runner alive parked for genuinely
  // new input with a fresh budget. Only legacy local-queue batches (no durable row to pause)
  // keep the old exit path, preserving the A4-MED-3 no-unbounded-loop invariant.
  let lastStartupBatchUserMessageLocalIds: readonly string[] = [];
  const noteStartupBatchLocalIds = (localIds: readonly string[] | null | undefined): void => {
    lastStartupBatchUserMessageLocalIds = normalizePendingDeliveryLocalIds(localIds);
  };
  const pauseExhaustedRelaunchBatchRows = async (): Promise<boolean> => {
    // The failing batch lives in exactly one of three places at exhaustion time: parked (pulled
    // but not yet handed to a run), in-flight (handed to the failing run, not provider-accepted),
    // or already returned to its durable rows (tracked local ids from the last startup batch).
    const localIds = normalizePendingDeliveryLocalIds(
      parkedMessage?.userMessageLocalIds?.length
        ? parkedMessage.userMessageLocalIds
        : inFlightStartupMessage?.batch.userMessageLocalIds?.length
          ? inFlightStartupMessage.batch.userMessageLocalIds
          : lastStartupBatchUserMessageLocalIds,
    );
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery?.bind(session.client);
    if (localIds.length === 0 || !blockPendingMessageDelivery) return false;
    const blocked = await blockPendingMessageDelivery({ localIds, reason: 'terminal_host_unreachable' })
      .catch((error) => {
        logger.debug('[unified]: failed to pause poisoned pending rows after relaunch budget exhaustion (non-fatal)', error);
        return false;
      });
    return blocked === true;
  };
  const parkAfterRelaunchBudgetExhausted = async (reason: string): Promise<boolean> => {
    const paused = await pauseExhaustedRelaunchBatchRows();
    if (!paused) {
      session.client.sendSessionEvent({
        type: 'message',
        message: `Claude unified terminal failed ${MAX_CONSECUTIVE_PARK_RELAUNCHES + 1} times in a row. Not retrying automatically — your queued message stays on the server and will be redelivered when the session restarts.`,
      });
      return false;
    }
    consecutiveParkRelaunches = 0;
    parkedMessage = null;
    inFlightStartupMessage = null;
    lastStartupBatchUserMessageLocalIds = [];
    session.client.sendSessionEvent({
      type: 'message',
      message: `Claude unified terminal failed ${MAX_CONSECUTIVE_PARK_RELAUNCHES + 1} times in a row. Your queued message is paused (not lost) — send a new message or retry the paused one to relaunch the terminal.`,
    });
    await flushUnifiedStartupFailureSurface(session, `${reason}_relaunch_budget_exhausted`);
    const batch = await waitForNextSessionInputBatch();
    if (!batch) return false;
    parkedMessage = batch;
    return true;
  };
  const parkForNextMessageAfterRuntimeIssue = async (reason: string): Promise<boolean> => {
    session.client.sendSessionEvent({
      type: 'message',
      message: 'Claude unified terminal exited unexpectedly. Waiting for the next message to retry...',
    });
    await flushUnifiedStartupFailureSurface(session, reason);
    const batch = await waitForNextSessionInputBatch();
    if (!batch) return false;
    parkedMessage = batch;
    return true;
  };
  const isInFlightStartupMessage = (input: Readonly<{
    message: string;
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>): boolean => {
    return inFlightStartupMessage !== null
      && inFlightStartupMessage.batch.message === input.message
      && inFlightStartupMessage.batch.maxUserMessageSeq === (input.maxUserMessageSeq ?? null)
      && areSameUserMessageLocalIds(inFlightStartupMessage.batch.userMessageLocalIds, input.userMessageLocalIds);
  };
  const restoreInFlightStartupMessageAfterHostStartupFailure = (): boolean => {
    if (!inFlightStartupMessage) return false;
    const inFlight = inFlightStartupMessage;
    inFlightStartupMessage = null;
    if (inFlight.source === 'initial') {
      initialPromptPending = true;
      return true;
    }
    try {
      session.queue.unshift(inFlight.batch.message, inFlight.batch.mode, {
        userMessageSeq: inFlight.batch.maxUserMessageSeq,
        userMessageLocalIds: inFlight.batch.userMessageLocalIds,
      });
    } catch (error) {
      logger.debug('[unified]: failed to requeue in-flight unified terminal startup message after startup failure', error);
    }
    return false;
  };

  // Initial goal (P1-E4): consumed once from the daemon-provided env and injected on the FIRST
  // launch only; a relaunch (park/respawn) must not re-inject it.
  let pendingInitialGoalObjective = readDaemonInitialGoalFromEnv()?.objective?.trim() || null;
  let unifiedTerminalLaunchAttempt = 0;
  const consumeInitialGoalObjective = (): string | undefined => {
    const objective = pendingInitialGoalObjective;
    pendingInitialGoalObjective = null;
    return objective ?? undefined;
  };
  const runUnifiedTerminalSessionOnce = async (): Promise<void> => {
    const knownClaudeSessionId = typeof session.sessionId === 'string' && session.sessionId.trim().length > 0
      ? session.sessionId.trim()
      : null;
    const claudeArgs = unifiedTerminalLaunchAttempt === 0
      ? initialPrompt.claudeArgs
      : buildClaudeRecoveryResumeArgs(initialPrompt.claudeArgs, knownClaudeSessionId);
    unifiedTerminalLaunchAttempt += 1;
    await runClaudeUnifiedTerminalSession({
      path: session.path,
      happySessionId: session.client.sessionId,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      claudeArgs,
      hookSettingsPath: session.hookSettingsPath,
      hookPluginDir: session.hookPluginDir,
      statuslineForwarder: session.claudeStatuslineForwarder ?? undefined,
      happierMcpConfigJson: mcpConfigJson,
      systemPromptText: session.defaultSystemPromptText,
      // A parked message (post-runtime-issue relaunch) must drive the relaunch mode itself,
      // so initialMode stays undefined and the parked batch becomes the first message.
      initialMode: initialPromptPending || parkedMessage || !opts.initialMode
        ? undefined
        : normalizeStartupMode(opts.initialMode),
      // C11 (incident cmq8y3nlx): binding-owned registry, seeded from the persisted prompt store,
      // so a respawned runner recognizes its predecessor's leftover composer injection as our own.
      ownComposerTexts: binding.ownComposerTexts,
      dialogChoiceBroker,
      adoptExistingTerminalHost: opts.adoptExistingTerminalHost === true,
      ...binding.sessionOptions,
      signal: abortController.signal,
      // A message pulled by the runner's input pump during a death/dispose unwind
      // must come back to the session queue instead of being dropped into the
      // dead host (silent queue-swallow, incident cmq8y3nlx). Server-owned
      // pending-delivery rows stay owned by the durable pending row; legacy
      // non-pending/local prompts still use the local queue handback.
      returnUnconsumedMessage: ({ message, mode, maxUserMessageSeq, userMessageLocalIds }) => {
        if (isInFlightStartupMessage({ message, maxUserMessageSeq, userMessageLocalIds })) {
          inFlightStartupMessage = null;
        }
        returnOrBlockUndeliverableProviderPrompt({
          input: { message, mode, maxUserMessageSeq, userMessageLocalIds },
          localIds: userMessageLocalIds,
          blockPendingMessageDelivery: session.client.blockPendingMessageDelivery?.bind(session.client),
          blockReason: 'runtime_disposed_before_delivery',
          requeueLegacyInput: (input) => {
            try {
              // Preserve watermark attribution: a re-pended legacy batch must stay confirmable at
              // its eventual provider acceptance (A3-HIGH-1).
              session.queue.unshift(input.message, input.mode, {
                userMessageSeq: input.maxUserMessageSeq ?? null,
                userMessageLocalIds: input.userMessageLocalIds ?? [],
              });
            } catch (error) {
              logger.debug('[unified]: failed to requeue undeliverable unified terminal message', error);
            }
          },
          logPrefix: '[unified]',
        });
      },
      // A3-HIGH-1 root fix: the delivered-user-message watermark persists HERE — when the
      // provider provably accepted the batch — not when the row entered volatile memory.
      onPromptAcceptedByProvider: ({ maxUserMessageSeq, userMessageLocalIds }) => {
        consecutiveParkRelaunches = 0;
        inFlightStartupMessage = null;
        lastStartupBatchUserMessageLocalIds = [];
        session.client.confirmUserMessageDeliveredToProvider?.(maxUserMessageSeq, {
          localIds: userMessageLocalIds,
        });
      },
      onPromptTerminallyRejectedBeforeProvider: ({ userMessageLocalIds, reason }) => {
        consecutiveParkRelaunches = 0;
        inFlightStartupMessage = null;
        lastStartupBatchUserMessageLocalIds = [];
        void session.client.blockPendingMessageDelivery?.({
          localIds: userMessageLocalIds,
          reason,
        }).catch((error) => {
          logger.debug('[unified]: failed to block deterministic pre-provider pending delivery rejection', error);
        });
      },
      runtimeActivityPublisher: session.runtimeActivityPublisher,
      registerTerminalComposerClearRuntimeControl: (clearTerminalComposer) =>
        session.client.registerSessionRuntimeControls?.({ clearTerminalComposer }) ?? (() => undefined),
      registerGoalRuntimeControl: (controls) =>
        session.client.registerSessionRuntimeControls?.(controls) ?? (() => undefined),
      // Claude's live `/goal clear` emits no goal_status, so the clear effector deterministically
      // removes the goal work-state item via the projector-owned goal source.
      clearGoalWorkState: () => transcriptProjector.clearGoalWorkState(),
      // Record the SET epoch when `/goal <objective>` reaches the terminal, so re-setting the same
      // objective after a clear is accepted instead of being suppressed as a stale replay (G2).
      recordGoalSetIntent: () => transcriptProjector.recordGoalSetIntent(),
      // Native Claude `/goal` source (plan H7): the goal_status attachment + the
      // system/init slash_commands ride the raw transcript channel (the scanner drops
      // them before `onMessage`). Feed the centralized goal source via the projector;
      // it keeps them out of the visible transcript.
      onRawTranscriptValue: (value) => {
        transcriptProjector.observeRaw(value);
      },
      initialGoalObjective: consumeInitialGoalObjective(),
      nextMessage: async () => {
        if (parkedMessage) {
          const parked = parkedMessage;
          const mode = observeOutgoingBatchMode(parked.mode);
          parkedMessage = null;
          inFlightStartupMessage = { source: 'parked', batch: { ...parked, mode } };
          noteStartupBatchLocalIds(parked.userMessageLocalIds);
          binding.noteNextInjectedPromptShouldSuppressEcho();
          return {
            ...parked,
            mode,
          };
        }
        if (initialPromptPending && initialPrompt.prompt) {
          initialPromptPending = false;
          binding.noteNextInjectedPromptShouldImportEcho();
          const initialBatchMode = observeOutgoingBatchMode(opts.initialMode ?? {
            permissionMode: session.lastPermissionMode ?? 'default',
            claudeUnifiedTerminalEnabled: true,
          });
          inFlightStartupMessage = {
            source: 'initial',
            batch: {
              message: initialPrompt.prompt,
              mode: initialBatchMode,
              maxUserMessageSeq: null,
              userMessageLocalIds: [],
            },
          };
          noteStartupBatchLocalIds([]);
          return {
            message: initialPrompt.prompt,
            mode: initialBatchMode,
          };
        }
        initialPromptPending = false;
        const batch = await waitForNextSessionInputBatch();
        if (!batch) return null;
        const mode = observeOutgoingBatchMode(batch.mode);
        inFlightStartupMessage = {
          source: 'queue',
          batch: {
            message: batch.message,
            mode,
            maxUserMessageSeq: batch.maxUserMessageSeq,
            userMessageLocalIds: batch.userMessageLocalIds,
          },
        };
        noteStartupBatchLocalIds(batch.userMessageLocalIds);
        binding.noteNextInjectedPromptShouldSuppressEcho();
        return {
          message: batch.message,
          mode,
          maxUserMessageSeq: batch.maxUserMessageSeq,
          userMessageLocalIds: batch.userMessageLocalIds,
        };
      },
      subscribeClaudeSessionHooks: (callback) => {
        session.addClaudeSessionHookCallback(callback);
        return () => {
          session.removeClaudeSessionHookCallback(callback);
        };
      },
      loadCommittedClaudeJsonlMessageBaseline: () =>
        session.client.fetchCommittedClaudeJsonlMessageBaseline?.()
        ?? { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null },
      // Unknown canonical state (no accessor) counts as ACTIVE (fail-closed).
      isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
      isPromptDeliveryAccepted: (batch) => session.client.hasUserMessageProviderAcceptance?.({
        userMessageSeq: batch.maxUserMessageSeq ?? null,
        localIds: batch.userMessageLocalIds ?? [],
      }) === true,
      // Persist a consumed marker for controller-command echoes the runner suppresses, so they
      // join the committed baseline and cannot replay as "new" messages after a respawn
      // (resume-replay leak, 2026-06-11).
      onTranscriptMessageSuppressed: (message) => {
        session.client.recordClaudeJsonlMessageConsumed?.(message, {
          suppressedBy: 'control_command_echo',
        });
      },
      onInFlightSteerAvailabilitySnapshot: inFlightSteerCapabilityPublisher.publish,
      onTerminalScreenObserved: observeTerminalScreen,
      // Lane X (incident cmq8y3nlx): one honest notice per starvation episode instead of a silent
      // 15s retry loop — the queued message is blocked by a draft in the terminal composer.
      onInFlightSteerUserDraftStarvation: () => {
        inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
        session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('in_flight_steer'));
      },
      onDraftGuardStarvation: (info) => {
        inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
        void sustainedPendingDeliveryBlockHandler.blockForSustainedBlocker({
          localIds: info.userMessageLocalIds,
          blocker: {
            kind: info.guardStatus === 'clear_failed'
              ? 'own_leftover_clear_failed'
              : info.guardStatus === 'capture_style_unavailable'
                ? 'capture_ambiguous'
                : 'terminal_user_draft',
            source: 'draft_guard',
            guardStatus: info.guardStatus,
            ...(info.draftLength !== undefined ? { draftLength: info.draftLength } : {}),
          },
          isCanonicalTurnActive: info.isCanonicalTurnActive ?? (session.client.hasActiveCanonicalTurn?.() ?? true),
        }).then((blocked) => {
          if (!blocked) {
            session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'));
          }
        });
      },
      onDraftGuardClear: () => {
        void sustainedPendingDeliveryBlockHandler.retryBlockedRowsOnce();
      },
      onSessionFound: (sessionId, data) => {
        session.onSessionFound(sessionId, data);
      },
      onThinkingChange: (thinking) => {
        session.onThinkingChange(thinking);
      },
      onUsageLimitDetails: surfaceRateLimit,
      onRuntimeAuthFailureEvent: async (error) => {
        try {
          const surfaced = await surfaceClaudeRuntimeAuthFailure(session, error, '[unified]');
          if (surfaced) {
            lastSurfacedRuntimeAuthFailureAtMs = Date.now();
            lastSurfacedRuntimeAuthFailureWasDaemonOwned = isClaudeRuntimeAuthFailureOwnedByDaemonRecovery(error);
          }
        } finally {
          binding.notePromptTurnTerminal();
        }
      },
      onPromptTurnTerminal: surfacePromptTurnTerminal,
      onTerminalInjectionFailure: surfaceTerminalRuntimeIssue,
      createStartupDialogResolver: ({ controlPort, startupMode, isRuntimeControlInFlight }) =>
        createClaudeUnifiedResumeChoiceStartupResolver({
          choice: startupMode.claudeUnifiedTerminalResumeChoice ?? 'ask_every_time',
          broker: resumeChoiceBroker,
          port: controlPort,
          wait: delay,
          settleMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
          startupMode,
          isRuntimeControlInFlight,
        }),
      tuiRuntimeControl: {
        featureEnabled: tuiRuntimeControlEnabled,
        emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => {
          session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent(event));
        },
        // F2 (qa/QA-B.md): one honest notice per stuck-unsafe-window episode — an idle queued
        // message kept deferring because runtime controls could not be applied over a composer
        // draft/dialog on the TUI. Mirrors the daemon-resume launcher wiring.
        onBlockedApplyStarvation: (info) => {
          if (isClaudeUnifiedRuntimeControlUserDraftBlocker(info.blockedReason)) {
            inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
            void sustainedPendingDeliveryBlockHandler.blockForSustainedBlocker({
              localIds: info.userMessageLocalIds,
              blocker: {
                kind: 'runtime_config_blocked',
                source: 'runtime_control',
                blockedReason: info.blockedReason,
              },
              isCanonicalTurnActive: info.isCanonicalTurnActive ?? (session.client.hasActiveCanonicalTurn?.() ?? true),
            }).then((blocked) => {
              if (!blocked) {
                session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'));
              }
            });
            return;
          }
          session.client.sendSessionEvent({
            type: 'message',
            message: 'Your queued message is waiting: the terminal shows a draft or dialog that blocks applying your settings change. Clear the terminal composer (or dismiss the dialog) to deliver it.',
          });
        },
        onBlockedApplyClear: () => {
          void sustainedPendingDeliveryBlockHandler.retryBlockedRowsOnce();
        },
        // Lane Y: feed statusline-reported effective model/effort into the controller's
        // lastVerified through the session-level statusline applier.
        registerStatuslineRuntimeReconciler: (reconcile) =>
          session.setClaudeStatuslineRuntimeReconciler(reconcile),
        registerMetadataRuntimeModeApplier: (apply) => {
          applyUnifiedTerminalMetadataMode = apply;
          void applyUnifiedTerminalPermissionMetadata.flushPending().catch((error) => {
            logger.debug('[unified]: failed to flush pending metadata runtime mode after applier registration', error);
          });
          return () => {
            if (applyUnifiedTerminalMetadataMode === apply) {
              applyUnifiedTerminalMetadataMode = null;
            }
          };
        },
      },
      onTerminalHostReady: ({ terminal }) => {
        startForegroundAttach({
          sessionId: session.client.sessionId,
          terminal,
        });
      },
    });
  };

  try {
    while (true) {
      try {
        await runUnifiedTerminalSessionOnce();
        return { type: 'exit', code: 0 };
      } catch (error) {
        if (isClaudeUnifiedTerminalHostDeadError(error)) {
          session.onThinkingChange(false);
          if (isRecentClaudeUnifiedTerminalAuthFailure({
            authFailureAtMs: lastSurfacedRuntimeAuthFailureAtMs,
            nowMs: Date.now(),
          })) {
            logger.debug('[unified]: terminal host died after Claude auth failure; keeping auth diagnostic primary');
            await flushUnifiedStartupFailureSurface(session, 'host_dead_after_auth_failure');
            binding.notePromptTurnTerminal();
            if (lastSurfacedRuntimeAuthFailureWasDaemonOwned) {
              lastSurfacedRuntimeAuthFailureWasDaemonOwned = false;
              continue;
            }
            throw error;
          }
          await surfacePrimarySessionRuntimeIssue({
            provider: 'claude',
            cause: 'process_exit',
            error,
            session: session.client,
            // Host death routinely lands between turns (incident cmq8y3nlx); an
            // idle lifecycle must still surface it instead of no-opping.
            allocateTurnWhenIdle: true,
          }).catch((surfaceError) => {
            logger.debug('[unified]: failed to surface Claude unified terminal host death (non-fatal)', surfaceError);
            return null;
          });
          sendUnifiedTerminalHostDeadMessage(session, {
            promptDeliveryWasPending: Boolean(initialPromptPending || parkedMessage || inFlightStartupMessage),
          });
          await flushUnifiedStartupFailureSurface(session, 'host_dead');
          binding.notePromptTurnTerminal();
          if (consumeParkRelaunchBudget() === 'exhausted') {
            if (await parkAfterRelaunchBudgetExhausted('host_dead')) continue;
            return { type: 'exit', code: 1 };
          }
          if (await parkForNextMessageAfterRuntimeIssue('host_dead')) continue;
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalReadinessTimeoutError(error)) {
          // Startup readiness timed out on a (possibly slow) live host. Surface a structured runtime issue
          // with diagnostics, then exit gracefully (D16) instead of escalating to a generic
          // `[claude] Fatal command error` / silent dead session in the standalone startup path.
          await surfaceTerminalRuntimeIssue(error);
          await flushUnifiedStartupFailureSurface(session, 'readiness_timeout');
          return { type: 'exit', code: 1 };
        }
        if (
          isInvalidPromptTextInjectionFailure(error)
          || isClaudeUnifiedTerminalManagedSettingsOptionError(error)
        ) {
          await surfaceTerminalRuntimeIssue(error);
          await flushUnifiedStartupFailureSurface(
            session,
            isInvalidPromptTextInjectionFailure(error)
              ? 'invalid_prompt_text'
              : 'managed_settings_option',
          );
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalRecoverableProviderAcceptanceUnknownFailure(error)) {
          session.onThinkingChange(false);
          await binding.recordPromptTurnCancelled().catch((cancelError) => {
            logger.debug('[unified]: failed to cancel Claude unified delivery-unknown turn (non-fatal)', cancelError);
          });
          sendUnifiedTerminalDeliveryUnknownMessage(session);
          await flushUnifiedStartupFailureSurface(session, 'provider_acceptance_unknown');
          return { type: 'exit', code: 1 };
        }
        if (error instanceof PendingQueueMaterializationAuthError) {
          logger.debug('[unified]: pending-queue pump stopped after supervisor auth failure; parking for recovered input');
          if (await parkForNextMessageAfterRuntimeIssue('pending_queue_auth_failure')) continue;
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalRuntimeIssueError(error)) {
          // Classified injection failure: surface structured, park for the next message, relaunch.
          // Never rethrow into `[claude] Fatal command error` (incident cmq7pyqkj).
          // Budget check precedes the startup-message restore: on exhaustion the poisoned batch
          // must be paused as a durable row, not re-queued locally where the park wait would
          // immediately re-feed it (RC-RESUMEFLAP).
          if (consumeParkRelaunchBudget() === 'exhausted') {
            await surfaceTerminalRuntimeIssue(error);
            if (await parkAfterRelaunchBudgetExhausted('injection_failure')) continue;
            return { type: 'exit', code: 1 };
          }
          const shouldRetryRestoredStartupMessage = isTerminalHostStartupError(error)
            && restoreInFlightStartupMessageAfterHostStartupFailure();
          await surfaceTerminalRuntimeIssue(error);
          if (shouldRetryRestoredStartupMessage) continue;
          if (await parkForNextMessageAfterRuntimeIssue('injection_failure')) continue;
          return { type: 'exit', code: 1 };
        }
        throw error;
      }
    }
  } finally {
    // G-6: mark an active-but-unmet Claude goal as interrupted on graceful teardown (status stays
    // active; the goal may resume) before the source is disposed.
    transcriptProjector.finalizeInterruptedGoal();
    // Drain any pending workflow-activity writes, then stop scheduling (dispose via reset()).
    await transcriptProjector.flushWorkflowActivity();
    transcriptProjector.reset();
    resumeChoiceBroker.dispose();
    dialogChoiceBroker.dispose();
    inFlightSteerCapabilityPublisher.dispose();
    sustainedPendingDeliveryBlockHandler.dispose();
    removeExternalAbortListener?.();
  }
}

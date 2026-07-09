import { rmdir, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type {
  ClaudeUnifiedTerminalHost,
  TerminalInputInjectionResult,
  TerminalInputInjectionV1,
} from '@happier-dev/agents';
import {
  SessionTerminalComposerClearResultV1Schema,
  type SessionTerminalComposerClearFailureStatusV1,
  type SessionTerminalComposerClearRequestV1,
  type SessionTerminalComposerClearResultV1,
} from '@happier-dev/protocol';

import {
  ClaudeUnifiedTerminalHostDeadError,
  createClaudeUnifiedController,
  type ClaudeUnifiedController,
} from './createClaudeUnifiedController';
import {
  createClaudeUnifiedHookLifecycleBridge,
  type ClaudeUnifiedPromptTurnTerminalEvent,
  type ClaudeUnifiedSessionEndEvent,
  type ClaudeUnifiedSessionHookSubscription,
} from './createClaudeUnifiedHookLifecycleBridge';
import { createReplayableHookSubscription } from './createReplayableHookSubscription';
import { createClaudeUnifiedTranscriptBridge } from './createClaudeUnifiedTranscriptBridge';
import {
  createClaudeUnifiedTerminalReadinessBridge,
  type ClaudeUnifiedStartupDialogResolver,
} from './createClaudeUnifiedTerminalReadinessBridge';
import { createClaudeUnifiedHostLivenessBridge } from './createClaudeUnifiedHostLivenessBridge';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import {
  createClaudeGoalRuntimeControls,
  type ClaudeGoalCommandDelivery,
  type ClaudeGoalRuntimeControls,
} from '../goalControl/claudeGoalRuntimeControl';
import { buildClaudeGoalCommand } from '../goalControl/claudeGoalCommand';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';
import {
  createClaudeUnifiedPromptInjector,
  type ClaudeUnifiedDraftGuardStarvationInfo,
} from './createClaudeUnifiedPromptInjector';
import { createClaudePromptSubmitVerificationPolicy } from './claudePromptSubmitVerification';
import { clearOwnLeftoverComposerDraft } from './ownComposerDraftGuard';
import {
  createClaudeUnifiedInFlightSteerEvaluator,
  type ClaudeUnifiedInFlightSteerWiring,
} from './createClaudeUnifiedInFlightSteerEvaluator';
import { createClaudeOwnComposerTextLog, type ClaudeOwnComposerTextLog } from './ownComposerTextLog';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';
import { doesClaudeUnifiedPromptBatchMatchAcceptedTranscript } from './acceptedPromptDeliveryIdentity';
import { ClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';
import type { ClaudeProviderRuntimeActivityPublisher } from '../providerActivity/createClaudeProviderActivityLedger';
import {
  buildClaudeUnifiedRuntimeControlDisabledOutcomeEvents,
  createBlockedApplyStarvationTracker,
  createClaudeUnifiedRuntimeControlBridge,
  DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD,
  mapEnhancedModeToDesiredRuntimeConfig,
  resolveBlockedApplyRetryMs,
  type BlockedApplyStarvationInfo,
  type ClaudeUnifiedRuntimeConfigOutcomeEvent,
  type ClaudeUnifiedRuntimeControlBridge,
  type ClaudeUnifiedRuntimeControlApplyResult,
} from './runtimeControlIntegration';
import {
  clearUserAuthorizedClaudeComposerDraft,
  createClaudeSettingsGuard,
  createClaudeUnifiedTuiControlController,
  DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
  resolveClaudeConfigRootFromEnv,
  type ClaudeComposerClearRefusalReason,
  type ClaudeStatuslineRuntimeMetadata,
  type ClaudeUserAuthorizedComposerClearResult,
} from './tuiControls';
import {
  createClaudeUnifiedDialogChoiceScreenProbe,
  type ClaudeUnifiedDialogChoiceScreenProbe,
} from './dialogChoice/claudeUnifiedDialogChoiceScreenProbe';
import type { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';
import {
  createClaudeUnifiedControlCommandEchoBookkeeper,
  type ClaudeUnifiedControlCommandEchoBookkeeper,
} from './controlCommandEcho';
import type {
  ClaudeUnifiedInputConsumer,
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedStartableDisposable,
  ClaudeUnifiedTerminalScreenObservation,
} from './_types';
import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import type { SessionHookData } from '../utils/startHookServer';
import { resolveClaudeConfigDirOverride } from '../utils/resolveClaudeConfigDirOverride';
import type { MessageBatch } from '@/agent/runtime/sessionInput/types';
import type { Metadata } from '@/api/types';
import {
  buildTerminalAttachmentMetadataFromHostHandle,
  buildTerminalHostHandleFromAttachmentMetadata,
} from '@/agent/runtime/terminal/attachmentMetadata';
import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostResolution,
} from '@/integrations/terminalHost/_types';
import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';
import { persistTerminalAttachmentInfoIfNeeded } from '@/agent/runtime/startupSideEffects';
import {
  readTerminalAttachmentInfo,
  removeTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import {
  evaluateTerminalHostLivenessForRecovery,
  isTerminalHostConfirmedDeadForRelaunch,
  shouldDiscardTerminalAttachmentAfterRecoveryProbe,
} from '@/integrations/terminalHost/livenessPolicy';
import { createTerminalHostRegistry } from '@/integrations/terminalHost/registry';
import { resolveTerminalHost } from '@/integrations/terminalHost/resolveTerminalHost';
import { createTmuxTerminalHostAdapter, isTmuxAvailable } from '@/integrations/tmux';
import { createPtyTerminalHostAdapter } from '@/integrations/pty';
import { createZellijTerminalHostAdapter } from '@/integrations/zellij/adapter';
import { createWindowsTerminalZellijForegroundClientLauncher } from '@/integrations/zellij/windowsForegroundClient';
import { configuration } from '@/configuration';
import {
  buildClaudeUnifiedTerminalSpawn,
  type ClaudeUnifiedTerminalSpawn,
} from './buildClaudeUnifiedTerminalSpawn';
import { resolveZellijWindowsGuard } from '@/integrations/zellij/zellijWindowsGuards';
import { resolveZellijRuntimeBinary } from '@/integrations/zellij/runtimeBinary';
import {
  createClaudeUnifiedTelemetrySink,
  emitClaudeUnifiedHostDead,
  emitClaudeUnifiedWindowsGuardTriggered,
  maybeEmitClaudeUnifiedWindowsGuardTriggered,
  type ClaudeUnifiedTelemetrySink,
} from './telemetry';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { logger } from '@/ui/logger';
import {
  clearSessionMarkerTerminalHostHealth,
  publishSessionMarkerTerminalHostHealth,
} from '@/daemon/sessionRegistry';

type ClaudeUnifiedTerminalQueuedInput<Mode> = Readonly<{
  message: string;
  mode: Mode;
  /** Owed-delivery watermark attribution (A3-HIGH-1); see ClaudeUnifiedPromptBatch. */
  maxUserMessageSeq?: number | null;
  userMessageLocalIds?: readonly string[] | null;
  /**
   * True when the prompt comes from a durable provider-acceptance pending handoff. The terminal
   * may already contain this prompt, or a partial residue of it, before the arbiter injects.
   */
  providerAcceptancePending?: boolean | null;
}>;

type ClaudeUnifiedTerminalAcceptedInput<Mode> =
  ClaudeUnifiedTerminalQueuedInput<Mode> & ClaudeUnifiedPromptAcceptance;

type ClaudeUnifiedTerminalHostPreference = ClaudeUnifiedTerminalHost;
type ClaudeUnifiedProcessSignal = 'SIGINT' | 'SIGTERM';
type ClaudeUnifiedProcessSignals = Readonly<{
  once(event: ClaudeUnifiedProcessSignal, listener: () => void): unknown;
  removeListener(event: ClaudeUnifiedProcessSignal, listener: () => void): unknown;
}>;

export class ClaudeUnifiedTerminalHostUnavailableError extends Error {
  readonly code = 'claude_unified_terminal_host_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeUnifiedTerminalHostUnavailableError';
  }
}

export type ClaudeUnifiedTerminalSessionOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  path: string;
  happySessionId?: string | null | undefined;
  sessionId?: string | null | undefined;
  transcriptPath?: string | null | undefined;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  systemPromptText?: string | null | undefined;
  /** Hook-server coordinates for the statusline forwarder wrapper (see buildClaudeUnifiedTerminalSpawn). */
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
  /** Adopt a surviving terminal host instead of relaunching Claude after endpoint-rebound recovery. */
  adoptExistingTerminalHost?: boolean | undefined;
  signal?: AbortSignal | undefined;
  initialMode?: Mode | undefined;
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>;
  /**
   * Hands back a queued message that was already consumed by the input pump but
   * can no longer be delivered (host-death/dispose unwind), so the owner can
   * requeue it instead of the message being silently dropped into a dead session.
   */
  returnUnconsumedMessage?: ((input: ClaudeUnifiedTerminalQueuedInput<Mode>) => void) | undefined;
  /**
   * Provider-acceptance seam for the owed-delivery watermark (A3-HIGH-1): fired once per prompt
   * batch the provider ACCEPTED (arbiter acceptance, i.e. transcript/hook-confirmed). Launchers
   * persist the delivered-user-message watermark here instead of at queue handoff.
   */
  onPromptAcceptedByProvider?: ((input: Readonly<{
    message: string;
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
  }>) => void) | undefined;
  /**
   * Deterministic pre-provider rejections consume the local batch but can never reach provider
   * custody. Launchers must terminalize the attributed pending seq so restart replay cannot
   * rematerialize the same invalid prompt.
   */
  onPromptTerminallyRejectedBeforeProvider?: ((input: Readonly<{
    message: string;
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    reason: 'invalid_prompt_text';
  }>) => void) | undefined;
  resolveHostAdapter?: ((preference: ClaudeUnifiedTerminalHostPreference) => Promise<TerminalHostResolution>) | undefined;
  buildSpawn?: ((params: Readonly<{
    first: ClaudeUnifiedTerminalQueuedInput<Mode>;
    path: string;
    happySessionId?: string | null | undefined;
    claudeArgs?: readonly string[] | undefined;
    hookSettingsPath?: string | undefined;
    hookPluginDir?: string | null | undefined;
    happierMcpConfigJson?: string | undefined;
    systemPromptText?: string | null | undefined;
    statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
  }>) => Promise<ClaudeUnifiedTerminalSpawn>) | undefined;
  readTerminalHostAttachmentInfo?: typeof readTerminalAttachmentInfo | undefined;
  createSessionName?: (() => string) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  subscribeClaudeSessionHooks?: ClaudeUnifiedSessionHookSubscription | undefined;
  lifecycleCompletionQuiescenceMs?: number | undefined;
  dialogChoiceBroker?: ClaudeUnifiedDialogChoiceBroker | undefined;
  dialogOwnershipGraceMs?: number | undefined;
  dialogTurnStallScreenProbeQuietMs?: number | undefined;
  dialogTurnStallScreenProbeMaxAttempts?: number | undefined;
  onThinkingChange?: ((thinking: boolean) => void) | undefined;
  onReady?: (() => void | Promise<void>) | undefined;
  onUsageLimitDetails?: ((details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>) | undefined;
  onTerminalScreenObserved?: ((observation: ClaudeUnifiedTerminalScreenObservation) => void) | undefined;
  onRuntimeAuthFailureEvent?: ((error: unknown) => void | Promise<void>) | undefined;
  onProviderPromptStarted?: (() => void | Promise<void>) | undefined;
  onPromptTurnTerminal?: ((event: ClaudeUnifiedPromptTurnTerminalEvent) => void | Promise<void>) | undefined;
  runtimeActivityPublisher?: ClaudeProviderRuntimeActivityPublisher | null | undefined;
  onMessage?: ((message: RawJSONLines) => void) | undefined;
  /**
   * Raw transcript channel (plan H7): every parsed JSONL value BEFORE the scanner's
   * visible-transcript filtering. Native Claude `/goal` state is a `goal_status`
   * ATTACHMENT (and `/goal` capability rides the system/init `slash_commands`); the
   * scanner drops both before `onMessage` (F2 visible-transcript gate), so launchers
   * feed the centralized goal source from THIS channel instead. Never emit these to
   * the visible transcript.
   */
  onRawTranscriptValue?: ((value: unknown) => void) | undefined;
  /**
   * Invoked for every transcript row the runner suppresses from `onMessage` (controller-typed
   * slash-command echoes, L3). Launchers must persist a consumed marker
   * (`recordClaudeJsonlMessageConsumed`) so the row joins the committed baseline and cannot
   * replay as a "new" message after a same-session relaunch (resume-replay leak, 2026-06-11).
   */
  onTranscriptMessageSuppressed?: ((message: RawJSONLines) => void) | undefined;
  onSessionFound?: ((sessionId: string, data?: SessionHookData) => void) | undefined;
  loadCommittedClaudeJsonlMessageBaseline?: (() =>
    | Promise<import('../utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline>
    | import('../utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline) | undefined;
  allowFirstInputBeforeSessionStart?: boolean | undefined;
  /** Canonical session-turn lifecycle probe for the arbiter's stale-turn recovery (Lane N2). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  /** Canonical session delivery-state probe used to suppress ambiguous retries already accepted by the provider. */
  isPromptDeliveryAccepted?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => boolean) | undefined;
  /**
   * Lane P (O-design Seam A): de-duplicated session-level steer availability tee from the steer
   * evaluator. Launchers publish it to agentState via the capability publisher.
   */
  onInFlightSteerAvailabilitySnapshot?: ((snapshot: Readonly<{ available: boolean; reason: 'unsafe_window' | 'user_terminal_draft' | null }>) => void) | undefined;
  /**
   * Lane X (incident cmq8y3nlx): one-shot per starvation episode — a steered pending prompt has
   * been blocked by a terminal composer draft past the bounded veto threshold. Launchers surface
   * a single user-visible session notice (never a silent retry loop).
   */
  onInFlightSteerUserDraftStarvation?: ((info: Readonly<{
    consecutiveVetoes: number;
    ownLeftover: boolean;
    draftLength: number;
  }>) => void) | undefined;
  /**
   * Phase 1 draft-guard honesty: one-shot per idle injection starvation episode — a queued prompt
   * has been blocked by an unresolved terminal composer draft or clear failure past the bounded
   * retry threshold. Launchers surface a single user-visible session notice.
   */
  onDraftGuardStarvation?: ((info: ClaudeUnifiedDraftGuardStarvationInfo) => void) | undefined;
  /**
   * Fired when the pre-injection draft guard observes an injectable composer again after a
   * starvation episode. Launchers use this as the self-heal seam for rows this runtime blocked.
   */
  onDraftGuardClear?: (() => void) | undefined;
  /**
   * C11 (incident cmq8y3nlx): caller-owned own-injected-text registry. Launchers pass the binding's
   * registry, which is seeded from the persisted prompt store BEFORE the run, so a respawned runner
   * still recognizes (and may clear) its predecessor's leftover composer injection instead of
   * starving behind an honest-but-unresolvable `user_draft` veto. Defaults to a fresh in-memory log.
   */
  ownComposerTexts?: ClaudeOwnComposerTextLog | undefined;
  initialHostLivenessTimeoutMs?: number | undefined;
  initialHostLivenessPollMs?: number | undefined;
  /**
   * How long an uninterrupted streak of FAILED liveness probes (thrown, e.g. zellij CLI timeouts —
   * inconclusive, unlike conclusive dead observations) must last before the host is declared dead.
   * Incident cmq8y3nlx 2026-06-12: two timed-out probes ~1s apart must not kill a healthy session.
   */
  hostLivenessProbeFailureConfirmDeadMs?: number | undefined;
  providerAcceptanceTimeoutMs?: number | undefined;
  setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null | undefined;
  /**
   * Registers the user-authorized terminal composer clear control while this concrete terminal host
   * is alive. The runner owns the terminal control port; the launcher owns session runtime controls.
   */
  registerTerminalComposerClearRuntimeControl?: ((
    clearTerminalComposer: (
      request: Readonly<SessionTerminalComposerClearRequestV1>,
    ) => Promise<SessionTerminalComposerClearResultV1>,
  ) => (() => void) | void) | undefined;
  /**
   * Registers the Claude `/goal` effector as live session runtime controls (P1-E3). For an active
   * session the goal router prefers the live RPC, which calls these controls to inject a literal
   * `/goal` user turn into the arbiter. For SET the emitted `goal_status` attachment is the source of
   * truth (no metadata write here); for CLEAR there is no echoed status, so the control additionally
   * removes the goal work-state item via `clearGoalWorkState`.
   */
  registerGoalRuntimeControl?: ((
    controls: ClaudeGoalRuntimeControls,
  ) => (() => void) | void) | undefined;
  /**
   * Removes the published Claude goal work-state item (used by the live clear effector, since Claude
   * emits no `goal_status` for `/goal clear`). Provided by the launcher that owns the goal source.
   */
  clearGoalWorkState?: (() => void) | undefined;
  /**
   * Records a goal-control SET intent (used by the live set effector once the `/goal <objective>`
   * inject reaches the terminal), so re-setting the same objective after a clear is accepted instead
   * of being suppressed as a stale post-clear replay (G2). Provided by the launcher that owns the
   * goal source.
   */
  recordGoalSetIntent?: (() => void) | undefined;
  /**
   * Initial goal objective to pursue on (re)launch (P1-E4). When set, a single `/goal <objective>`
   * is injected once the arbiter is ready (mirrors Codex's initial `thread/goal/set`).
   */
  initialGoalObjective?: string | undefined;
  onTerminalPromptInjected?: ((input: ClaudeUnifiedTerminalAcceptedInput<Mode>) => void | Promise<void>) | undefined;
  onTerminalInjectionFailure?: ((error: ClaudeUnifiedTerminalInjectionFailureError) =>
    void
    | Readonly<{ action: 'claimed_pending_delivery' }>
    | Readonly<{ action: 'surfaced_runtime_issue' }>
    | Promise<
      | void
      | Readonly<{ action: 'claimed_pending_delivery' }>
      | Readonly<{ action: 'surfaced_runtime_issue' }>
    >
  ) | undefined;
  onTerminalHostReady?: ((params: Readonly<{
    handle: TerminalHostHandle;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  persistTerminalHostAttachmentInfo?: ((params: Readonly<{
    sessionId: string;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  removeTerminalHostAttachmentInfo?: ((params: Readonly<{
    sessionId: string;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  clearSessionMarkerTerminalHostHealth?: typeof clearSessionMarkerTerminalHostHealth | undefined;
  processSignals?: ClaudeUnifiedProcessSignals | null | undefined;
  createController?: ((params: Readonly<{
    hostAdapter: TerminalHostAdapter;
    inputInjection: TerminalInputInjectionV1;
    inputConsumer: ClaudeUnifiedInputConsumer<Mode>;
  }>) => ClaudeUnifiedController | Promise<ClaudeUnifiedController>) | undefined;
  createStartupDialogResolver?: ((params: Readonly<{
    controlPort: TerminalControlPort;
    startupMode: Mode;
    isRuntimeControlInFlight: () => boolean;
  }>) => ClaudeUnifiedStartupDialogResolver | null | undefined) | undefined;
  tuiRuntimeControl?: ClaudeUnifiedTuiRuntimeControlOptions<Mode> | undefined;
}>;

/**
 * Lane E runtime-control integration options. When `featureEnabled` is true and the resolved host exposes
 * a runtime-control port, the runner instantiates the Claude Unified TUI control controller + bridge and
 * applies verified model/effort/permission-mode controls before each dependent prompt injection. When the
 * gate is off (or no control port is available), the runner does not gate injection and the existing
 * restart-notice path is preserved (no regression).
 */
export type ClaudeUnifiedTuiRuntimeControlOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  featureEnabled: boolean;
  sessionModeEmissionEnabled?: boolean | undefined;
  emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => void;
  /** Delay before a control-gated prompt injection is retried after a blocked apply. */
  blockedInjectionRetryMs?: number | undefined;
  /**
   * F2 starvation honesty (qa/QA-B.md): fired ONCE per episode when consecutive blocked
   * before-prompt applies cross the bounded threshold — the queued prompt is honestly stuck behind
   * an unsafe TUI window (draft/dialog/overlay) instead of silently re-deferring forever.
   */
  onBlockedApplyStarvation?: ((info: BlockedApplyStarvationInfo) => void) | undefined;
  /** Fired after a previously blocked runtime-control apply can proceed again. */
  onBlockedApplyClear?: (() => void) | undefined;
  /** Test seam: blocked-apply starvation threshold override. */
  blockedApplyStarvationThreshold?: number | undefined;
  /** Test seam: inject a prebuilt bridge instead of constructing one from the host control port. */
  createBridge?: (() => ClaudeUnifiedRuntimeControlBridge | null) | undefined;
  /**
   * Lane Y: register the live statusline → lastVerified reconciler with the session-level
   * statusline feed (the statusline applier forwards effective model/effort through it into the
   * controller). Returns an unregister function; the runner unregisters on teardown so a stale
   * bridge never consumes payloads meant for a relaunched host.
   */
  registerStatuslineRuntimeReconciler?: ((
    reconcile: (metadata: ClaudeStatuslineRuntimeMetadata) => void,
  ) => () => void) | undefined;
  /**
   * Register a metadata-only immediate permission/config applier. The launcher calls this when
   * session metadata changes without a queued prompt; the runner routes it through the same
   * runtime-control bridge used before prompt injection, or emits structured restart outcomes when
   * live control is unavailable.
   */
  registerMetadataRuntimeModeApplier?: ((
    apply: (mode: Mode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>,
  ) => (() => void) | void) | undefined;
}>;

const DEFAULT_RUNTIME_CONTROL_BLOCKED_INJECTION_RETRY_MS = 250;
const DEFAULT_DIALOG_OWNERSHIP_GRACE_MS = 300;
const DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_QUIET_MS = 45_000;
const DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_MAX_ATTEMPTS = 3;
const MAX_RECENT_ACCEPTED_TRANSCRIPT_CANDIDATES = 64;
const PROVIDER_ACCEPTANCE_PENDING_PREFIX_RESIDUE_MIN_CHARS = 16;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeSessionName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'session';
}

function createDefaultSessionName(): string {
  return `happier-claude-unified-${sanitizeSessionName(String(process.pid))}-${Date.now()}`;
}

function normalizeHostPreferenceForCurrentPlatform(
  preference: ClaudeUnifiedTerminalHostPreference,
): ClaudeUnifiedTerminalHostPreference {
  if (process.platform === 'win32' && preference === 'tmux') {
    return 'auto';
  }
  return preference;
}

function isClaudeUnifiedReusableTerminalHostKind(
  kind: TerminalHostKind,
): kind is Exclude<ClaudeUnifiedTerminalHostPreference, 'auto'> {
  return kind === 'tmux' || kind === 'zellij';
}

function disposeReplayableHookSubscription(
  subscription: ReturnType<typeof createReplayableHookSubscription> | null,
): void {
  subscription?.dispose();
}

export function shouldProbeTmuxForClaudeUnifiedDefaultHost(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

async function resolveDefaultHostAdapter(
  preference: ClaudeUnifiedTerminalHostPreference,
  telemetry: ClaudeUnifiedTelemetrySink,
): Promise<TerminalHostResolution> {
  const promptSubmitVerification = createClaudePromptSubmitVerificationPolicy();
  const windowsConsolePromptSubmitVerification = createClaudePromptSubmitVerificationPolicy({
    verifySingleLineAfterSubmit: true,
  });
  const tmuxAvailable = shouldProbeTmuxForClaudeUnifiedDefaultHost()
    ? await isTmuxAvailable()
    : false;
  const windowsConsoleAdapter = process.platform === 'win32'
    ? createPtyTerminalHostAdapter({ promptSubmitVerification: windowsConsolePromptSubmitVerification })
    : null;
  const shouldConfigureZellij = process.platform !== 'win32' || preference === 'zellij' || !windowsConsoleAdapter;
  const zellijBinary = shouldConfigureZellij ? await resolveZellijRuntimeBinary() : null;
  const zellijWindowsGuard = shouldConfigureZellij
    ? resolveZellijWindowsGuard({
        platform: process.platform,
        arch: process.arch,
        env: process.env,
      })
    : { status: 'ok' } as const;
  if (shouldConfigureZellij) {
    if (zellijWindowsGuard.status === 'disabled') {
      emitClaudeUnifiedWindowsGuardTriggered(telemetry, zellijWindowsGuard.reason);
      return {
        status: 'disabled',
        reason: zellijWindowsGuard.reason,
        message: zellijWindowsGuard.message,
      };
    }
    if (process.platform === 'win32' && zellijWindowsGuard.shell === 'cmd.exe') {
      emitClaudeUnifiedWindowsGuardTriggered(telemetry, 'windows_default_shell_cmd');
    }
  }
  const resolvedZellijWindowsGuard = zellijWindowsGuard.status === 'ok' ? zellijWindowsGuard : null;
  const adapters = createTerminalHostRegistry([
    ...(windowsConsoleAdapter ? [windowsConsoleAdapter] : []),
    ...(tmuxAvailable ? [createTmuxTerminalHostAdapter({ promptSubmitVerification })] : []),
    ...(zellijBinary
      ? [
          createZellijTerminalHostAdapter({
            zellijBinary,
            happyHomeDir: configuration.happyHomeDir,
            promptSubmitVerification,
            defaultShell: resolvedZellijWindowsGuard?.shell,
            ...(resolvedZellijWindowsGuard?.launchStrategy === 'foreground_windows_terminal'
              ? {
                  launchStrategy: {
                    type: 'foregroundAttached',
                    launchClient: createWindowsTerminalZellijForegroundClientLauncher(),
                  } as const,
                }
              : {}),
            actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
          }),
        ]
      : []),
  ]);

  return resolveTerminalHost({
    preference,
    platform: { os: process.platform, arch: process.arch },
    adapters,
    tmuxAvailable,
    zellijAvailable: Boolean(zellijBinary),
  });
}

async function buildDefaultSpawn(params: Readonly<{
  first: ClaudeUnifiedTerminalQueuedInput<EnhancedMode>;
  path: string;
  happySessionId?: string | null | undefined;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  systemPromptText?: string | null | undefined;
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
}>): Promise<ClaudeUnifiedTerminalSpawn> {
  return buildClaudeUnifiedTerminalSpawn(params);
}

type ExistingTerminalHostAttachment = Readonly<{
  handle: TerminalHostHandle;
  terminal: NonNullable<Metadata['terminal']>;
}>;

async function readExistingTerminalHostAttachment(params: Readonly<{
  sessionId?: string | null | undefined;
  readAttachmentInfo: typeof readTerminalAttachmentInfo;
}>): Promise<ExistingTerminalHostAttachment | null> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) return null;
  const info = await params.readAttachmentInfo({
    happyHomeDir: configuration.happyHomeDir,
    sessionId,
  });
  if (!info) return null;
  const handle = buildTerminalHostHandleFromAttachmentMetadata(info.terminal);
  if (!handle) return null;
  return { handle, terminal: info.terminal };
}

async function removeUnreadLaunchSpec(spawn: ClaudeUnifiedTerminalSpawn): Promise<void> {
  if (!spawn.launchSpecPath) return;
  await unlink(spawn.launchSpecPath).catch(() => undefined);
  const specDir = dirname(spawn.launchSpecPath);
  if (basename(specDir).startsWith('happier-terminal-launch-')) {
    await rmdir(specDir).catch(() => undefined);
  }
}

function isClaudePromptInputExit(event: ClaudeUnifiedSessionEndEvent): boolean {
  return event.reason === 'prompt_input_exit';
}

function isCleanTerminalExit(liveness: Readonly<{ paneExitStatus?: number | undefined }>): boolean {
  return liveness.paneExitStatus === 0;
}

function waitForAnyAbort(signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanups: Array<() => void> = [];
    const onAbort = () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolve();
    };
    for (const signal of signals) {
      const listener = () => onAbort();
      cleanups.push(() => signal.removeEventListener('abort', listener));
      signal.addEventListener('abort', listener, { once: true });
    }
  });
}

function bindProcessSignalCleanup(params: Readonly<{
  processSignals: ClaudeUnifiedProcessSignals;
  abortController: AbortController;
  dispose: () => Promise<void>;
}>): () => void {
  let cleanupStarted = false;
  const onSignal = () => {
    if (!params.abortController.signal.aborted) {
      params.abortController.abort('claude-unified-process-signal');
    }
    if (cleanupStarted) return;
    cleanupStarted = true;
    void params.dispose().catch((error) => {
      logger.debug('[unified]: failed to dispose Claude unified terminal session during process signal cleanup', error);
    });
  };

  params.processSignals.once('SIGINT', onSignal);
  params.processSignals.once('SIGTERM', onSignal);

  return () => {
    params.processSignals.removeListener('SIGINT', onSignal);
    params.processSignals.removeListener('SIGTERM', onSignal);
  };
}

function createProvisionalTerminalHostHandle(params: Readonly<{
  kind: TerminalHostHandle['kind'];
  sessionName: string;
}>): TerminalHostHandle {
  return {
    kind: params.kind,
    sessionName: params.sessionName,
    ...(params.kind === 'tmux' ? { paneId: params.sessionName } : {}),
    attachMetadata: {
      attachStrategy: 'terminal_host',
      topology: 'shared',
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    },
  };
}

async function disposeHostForProcessSignal(dispose: () => Promise<void>): Promise<void> {
  try {
    await dispose();
  } catch (error) {
    logger.debug('[unified]: failed to dispose Claude unified terminal session during process signal cleanup', error);
  }
}

function normalizeMessageBatch<Mode>(input: ClaudeUnifiedTerminalQueuedInput<Mode>): MessageBatch<Mode, string> {
  return {
    message: input.message,
    mode: input.mode,
    isolate: false,
    hash: 'claude-unified-terminal',
    maxUserMessageSeq: input.maxUserMessageSeq ?? null,
    userMessageLocalIds: input.userMessageLocalIds ?? [],
    providerAcceptancePending: input.providerAcceptancePending === true,
  };
}

function isCompactBoundaryTranscriptMessage(message: RawJSONLines): boolean {
  return message.type === 'system' && (message as Record<string, unknown>).subtype === 'compact_boundary';
}

function isAcceptedPromptTranscriptCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const type = (value as Record<string, unknown>).type;
  return type === 'user' || type === 'queue-operation' || type === 'attachment';
}

function isCompactSlashCommandPrompt(message: string): boolean {
  const trimmed = message.trim();
  return trimmed === '/compact' || trimmed.startsWith('/compact ');
}

function isDeterministicInvalidPromptTextFailure(
  failure: Readonly<{
    failureState: string;
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  }>,
): boolean {
  return failure.failureState === 'failed_terminal'
    && failure.result.reason === 'invalid_prompt_text'
    && failure.result.phase === 'before_write'
    && failure.result.duplicateRisk === 'none'
    && failure.result.recoverable === false;
}

function createCompositeBridge(
  bridges: ReadonlyArray<ClaudeUnifiedStartableDisposable | undefined>,
): ClaudeUnifiedStartableDisposable | undefined {
  const activeBridges = bridges.filter((bridge): bridge is ClaudeUnifiedStartableDisposable => Boolean(bridge));
  if (activeBridges.length === 0) return undefined;
  return {
    start(opts) {
      return Promise.all(activeBridges.map((bridge) => Promise.resolve(bridge.start(opts))))
        .then(() => undefined);
    },
    async dispose() {
      let firstError: unknown;
      for (const bridge of [...activeBridges].reverse()) {
        try {
          await Promise.resolve(bridge.dispose());
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) {
        throw firstError;
      }
    },
  };
}

function createInputConsumer<Mode>(
  first: ClaudeUnifiedTerminalQueuedInput<Mode> | null,
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>,
): ClaudeUnifiedInputConsumer<Mode> {
  let firstPending = first !== null;
  return {
    async waitForNextInput() {
      if (firstPending && first) {
        firstPending = false;
        return normalizeMessageBatch(first);
      }
      const next = await nextMessage();
      return next ? normalizeMessageBatch(next) : null;
    },
  };
}

async function persistTerminalHostAttachmentInfoIfAvailable(params: Readonly<{
  sessionId: string | null | undefined;
  handle: TerminalHostHandle;
  persist: NonNullable<ClaudeUnifiedTerminalSessionOptions['persistTerminalHostAttachmentInfo']>;
}>): Promise<NonNullable<Metadata['terminal']> | null> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) return null;

  const terminal = buildTerminalAttachmentMetadataFromHostHandle(params.handle);
  if (!terminal) return null;

  await params.persist({ sessionId, terminal });
  return terminal;
}

async function removeTerminalHostAttachmentInfoIfAvailable(params: Readonly<{
  sessionId: string | null | undefined;
  terminal: NonNullable<Metadata['terminal']> | null;
  remove: NonNullable<ClaudeUnifiedTerminalSessionOptions['removeTerminalHostAttachmentInfo']>;
}>): Promise<void> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId || !params.terminal) return;

  await params.remove({ sessionId, terminal: params.terminal });
}

async function tryRemoveTerminalHostAttachmentInfo(params: Readonly<{
  sessionId: string | null | undefined;
  terminal: NonNullable<Metadata['terminal']> | null;
  remove: NonNullable<ClaudeUnifiedTerminalSessionOptions['removeTerminalHostAttachmentInfo']>;
}>): Promise<void> {
  try {
    await removeTerminalHostAttachmentInfoIfAvailable(params);
  } catch {
    // Attachment removal is best-effort. A stale attachment must not block fresh recovery.
  }
}

async function removeDefaultTerminalHostAttachmentInfo(params: Readonly<{
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
}>): Promise<void> {
  await removeTerminalAttachmentInfo({
    happyHomeDir: configuration.happyHomeDir,
    sessionId: params.sessionId,
    expectedTerminal: params.terminal,
  });
}

function mapClaudeComposerClearRefusalToProtocolStatus(
  reason: ClaudeComposerClearRefusalReason,
): SessionTerminalComposerClearFailureStatusV1 {
  switch (reason) {
    case 'generating':
      return 'generating';
    case 'no_interactive_composer':
      return 'not_safe';
    case 'permission_prompt':
    case 'permission_editor':
    case 'trust_prompt':
    case 'switch_model_dialog':
    case 'resume_choice_dialog':
    case 'effort_change_dialog':
    case 'unrecognized_confirmation_dialog':
    case 'slash_picker':
    case 'selection_list':
      return 'dialog_open';
  }
}

function mapClaudeComposerClearFailureReasonToProtocolStatus(
  reason: string,
): SessionTerminalComposerClearFailureStatusV1 {
  if (reason.startsWith('host_dead:')) return 'host_dead';
  if (reason.startsWith('capture_unsupported:')) return 'capture_unavailable';
  if (reason === 'clear_failed') return 'clear_failed';
  return 'clear_failed';
}

function mapClaudeComposerClearResultToProtocolResult(
  result: ClaudeUserAuthorizedComposerClearResult,
  sessionId: string,
): SessionTerminalComposerClearResultV1 {
  switch (result.status) {
    case 'cleared':
    case 'already_empty':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: true,
        status: result.status,
        sessionId,
      });
    case 'refused':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status: mapClaudeComposerClearRefusalToProtocolStatus(result.reason),
        sessionId,
        errorCode: result.reason,
        error: `terminal_composer_clear_refused:${result.reason}`,
      });
    case 'unsupported':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status: 'unsupported',
        sessionId,
        errorCode: result.reason ?? 'terminal_control_unsupported',
        error: result.reason ? `terminal_control_unsupported:${result.reason}` : 'terminal_control_unsupported',
      });
    case 'failed':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status: mapClaudeComposerClearFailureReasonToProtocolStatus(result.reason),
        sessionId,
        errorCode: result.reason,
        error: `terminal_composer_clear_failed:${result.reason}`,
      });
  }
}

export async function runClaudeUnifiedTerminalSession<Mode extends EnhancedMode = EnhancedMode>(
  opts: ClaudeUnifiedTerminalSessionOptions<Mode>,
): Promise<void> {
  const first = opts.initialMode ? null : await opts.nextMessage();
  if (!first && !opts.initialMode) return;
  const allowReadinessBeforeSessionStart = Boolean(first && opts.allowFirstInputBeforeSessionStart);
  const allowEmptyStartupInputBeforeSessionStart = first === null && Boolean(opts.initialMode);
  const acceptedPromptTranscriptDiscovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
    acceptedPromptWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
  });

  const telemetry = opts.telemetry ?? createClaudeUnifiedTelemetrySink();
  const publishHostDeadHealth = async (
    handle: TerminalHostHandle,
    liveness: unknown,
  ): Promise<void> => {
    const sessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
    if (!sessionId) return;
    const observedAt =
      liveness && typeof liveness === 'object' && typeof (liveness as { observedAt?: unknown }).observedAt === 'number'
        ? Math.max(0, Math.trunc((liveness as { observedAt: number }).observedAt))
        : Date.now();
    await publishSessionMarkerTerminalHostHealth({
      pid: process.pid,
      health: {
        status: 'host_dead',
        sessionId,
        runnerPid: process.pid,
        hostKind: handle.kind,
        ...(handle.kind === 'zellij' ? { zellijSessionName: handle.sessionName } : {}),
        observedAt,
        reason: 'host_dead',
      },
    }).catch((error) => {
      logger.debug('[unified]: failed to publish terminal host death to daemon marker state', error);
    });
  };
  const startupMode = first?.mode ?? opts.initialMode;
  if (!startupMode) return;
  const startupInput: ClaudeUnifiedTerminalQueuedInput<Mode> = first ?? {
    message: '',
    mode: startupMode,
  };
  const hostPreference = normalizeHostPreferenceForCurrentPlatform(startupMode.claudeUnifiedTerminalHost ?? 'auto');
  const resolveHostAdapterForPreference = async (preference: ClaudeUnifiedTerminalHostPreference): Promise<TerminalHostResolution> => (
    opts.resolveHostAdapter
      ? opts.resolveHostAdapter(preference)
      : resolveDefaultHostAdapter(preference, telemetry)
  );
  let hostResolution = await resolveHostAdapterForPreference(hostPreference);
  telemetry.emit({
    name: 'unified.session.host_resolved',
    properties: {
      kind: hostResolution.status === 'resolved' ? hostResolution.adapter.kind : 'disabled',
      platform: process.platform,
      preference: hostPreference,
      reason: hostResolution.reason,
    },
  });
  if (hostResolution.status !== 'resolved') {
    maybeEmitClaudeUnifiedWindowsGuardTriggered(telemetry, hostResolution.reason);
    throw new ClaudeUnifiedTerminalHostUnavailableError(hostResolution.message);
  }
  const savedTerminalHost = await readExistingTerminalHostAttachment({
    sessionId: opts.happySessionId,
    readAttachmentInfo: opts.readTerminalHostAttachmentInfo ?? readTerminalAttachmentInfo,
  });
  let existingTerminalHost = savedTerminalHost;
  if (existingTerminalHost && existingTerminalHost.handle.kind !== hostResolution.adapter.kind) {
    const attachedKind = existingTerminalHost.handle.kind;
    const attachedHostResolution = isClaudeUnifiedReusableTerminalHostKind(attachedKind)
      ? await resolveHostAdapterForPreference(attachedKind)
      : null;
    if (attachedHostResolution?.status === 'resolved') {
      hostResolution = attachedHostResolution;
    } else {
      await tryRemoveTerminalHostAttachmentInfo({
        sessionId: opts.happySessionId,
        terminal: existingTerminalHost.terminal,
        remove: opts.removeTerminalHostAttachmentInfo ?? removeDefaultTerminalHostAttachmentInfo,
      });
      existingTerminalHost = null;
    }
  }
  const discardExistingTerminalHost = async (
    existing: ExistingTerminalHostAttachment,
    reason: string,
  ): Promise<void> => {
    await hostResolution.adapter.dispose(existing.handle).catch((error) => {
      logger.warn('[unified]: failed to dispose stale terminal host before fresh acquisition; continuing', {
        reason,
        hostKind: existing.handle.kind,
        sessionName: existing.handle.sessionName,
        error,
      });
    });
    await tryRemoveTerminalHostAttachmentInfo({
      sessionId: opts.happySessionId,
      terminal: existing.terminal,
      remove: opts.removeTerminalHostAttachmentInfo ?? removeDefaultTerminalHostAttachmentInfo,
    });
  };
  if (existingTerminalHost) {
    const liveness = await evaluateTerminalHostLivenessForRecovery(hostResolution.adapter, existingTerminalHost.handle);
    if (liveness.liveness?.paneAlive !== true && shouldDiscardTerminalAttachmentAfterRecoveryProbe(liveness)) {
      await discardExistingTerminalHost(existingTerminalHost, 'saved_host_confirmed_dead');
      existingTerminalHost = null;
    } else if (liveness.liveness?.paneAlive !== true) {
      existingTerminalHost = null;
    }
  }
  let spawn: ClaudeUnifiedTerminalSpawn | null = null;
  let spawnEnvForRuntimeControl: Readonly<Record<string, string>> | null = null;
  const ensureSpawn = async (): Promise<ClaudeUnifiedTerminalSpawn> => {
    if (spawn) return spawn;
    spawn = await (opts.buildSpawn ?? buildDefaultSpawn)({
      first: startupInput,
      path: opts.path,
      happySessionId: opts.happySessionId,
      claudeArgs: opts.claudeArgs,
      hookSettingsPath: opts.hookSettingsPath,
      hookPluginDir: opts.hookPluginDir,
      happierMcpConfigJson: opts.happierMcpConfigJson,
      systemPromptText: opts.systemPromptText,
      statuslineForwarder: opts.statuslineForwarder,
    });
    spawnEnvForRuntimeControl = spawn.spawnEnv;
    return spawn;
  };
  const fallbackSessionName = opts.createSessionName?.() ?? createDefaultSessionName();
  const sessionName = existingTerminalHost?.handle.sessionName ?? fallbackSessionName;
  let handle: TerminalHostHandle | null = null;
  let controller: ClaudeUnifiedController | null = null;
  let runtimeControlBridge: ClaudeUnifiedRuntimeControlBridge | null = null;
  let dialogChoiceScreenProbe: ClaudeUnifiedDialogChoiceScreenProbe | null = null;
  let unregisterStatuslineRuntimeReconciler: (() => void) | null = null;
  let unregisterMetadataRuntimeModeApplier: (() => void) | null = null;
  let unregisterTerminalComposerClearRuntimeControl: (() => void) | null = null;
  let unregisterGoalRuntimeControl: (() => void) | null = null;
  let inFlightSteerWiring: ClaudeUnifiedInFlightSteerWiring<Mode> | null = null;
  let notifyTerminalComposerCleared: (() => void) | null = null;
  let terminalComposerClearedWakePending = false;
  let terminalAttachment: NonNullable<Metadata['terminal']> | null = null;
  let removeProcessSignalCleanup: (() => void) | null = null;
  let turnInterruptRegistered = false;
  let hookSubscription: ReturnType<typeof createReplayableHookSubscription> | null = null;
  const ensureHookSubscription = (): ReturnType<typeof createReplayableHookSubscription> => {
    hookSubscription ??= createReplayableHookSubscription(opts.subscribeClaudeSessionHooks);
    return hookSubscription;
  };
  const runtimeAbortController = new AbortController();
  const processSignalAbortController = new AbortController();
  let fatalRuntimeError: unknown = null;
  let startupHostLivenessGraceActive = true;
  let providerSessionStartedObserved = false;
  let trustedProviderProgressObserved = false;
  let expectedPromptInputExit = false;
  const observeTerminalScreen = (observation: ClaudeUnifiedTerminalScreenObservation): void => {
    opts.onTerminalScreenObserved?.(observation);
    void dialogChoiceScreenProbe?.evaluateScreenState(observation.screenState).catch((error) => {
      logger.debug('[unified]: Claude unified dialog observation failed', error);
    });
  };
  let observeSafeRuntimeBoundaryForMetadataApply: (() => Promise<void>) | null = null;
  let preHandleProcessSignalCleanupRan = false;
  let concreteHostDisposedByProcessSignal = false;
  const endStartupHostLivenessGrace = (): void => {
    startupHostLivenessGraceActive = false;
  };
  // Startup-readiness gate (Lane N3, incident cmq8y3nlx): no controls or prompt bytes may be
  // typed into the TUI until the SINGLE startup-readiness owner (the readiness bridge's
  // composer-evidence check) reports ready, or the provider provably accepted a prompt. The
  // arbiter's quietness heuristic alone can pass while the TUI is still initializing.
  let startupReadinessObservedForInjection = false;
  const observeStartupReadyForInjection = (): void => {
    startupReadinessObservedForInjection = true;
  };
  const observeTrustedProviderProgress = (): void => {
    trustedProviderProgressObserved = true;
    observeStartupReadyForInjection();
    if (opts.dialogChoiceBroker?.hasPendingChoice() === true) {
      opts.dialogChoiceBroker.noteDialogResolvedInTerminal('provider_progress_after_dialog_choice');
    }
  };
  const wakeAfterTerminalComposerClear = (): void => {
    if (notifyTerminalComposerCleared) {
      notifyTerminalComposerCleared();
      return;
    }
    terminalComposerClearedWakePending = true;
  };
  const observeProviderSessionStarted = (): void => {
    providerSessionStartedObserved = true;
    endStartupHostLivenessGrace();
  };
  const provisionalHandle = createProvisionalTerminalHostHandle({
    kind: hostResolution.adapter.kind,
    sessionName,
  });
  removeProcessSignalCleanup = bindProcessSignalCleanup({
    processSignals: opts.processSignals ?? process,
    abortController: processSignalAbortController,
    dispose: async () => {
      if (handle) {
        if (controller) {
          await controller.dispose();
        } else {
          await hostResolution.adapter.dispose(handle);
          concreteHostDisposedByProcessSignal = true;
        }
        return;
      }
      preHandleProcessSignalCleanupRan = true;
      await hostResolution.adapter.dispose(provisionalHandle);
    },
  });
  try {
    if (existingTerminalHost && opts.adoptExistingTerminalHost === true && hostResolution.adapter.adoptExistingHost) {
      try {
        handle = await hostResolution.adapter.adoptExistingHost(existingTerminalHost.handle);
        ensureHookSubscription();
      } catch (error) {
        const liveness = await evaluateTerminalHostLivenessForRecovery(hostResolution.adapter, existingTerminalHost.handle);
        if (!isTerminalHostConfirmedDeadForRelaunch(liveness)) {
          throw error;
        }
        await discardExistingTerminalHost(existingTerminalHost, 'adopt_failed_host_confirmed_dead');
        const fallbackSpawn = await ensureSpawn();
        ensureHookSubscription();
        handle = await hostResolution.adapter.createOrAttachHost({
          sessionName: fallbackSessionName,
          workingDirectory: opts.path,
          spawnArgv: fallbackSpawn.spawnArgv,
          spawnEnv: fallbackSpawn.spawnEnv,
          isolatedEnv: true,
        });
      }
    } else {
      const launchSpawn = await ensureSpawn();
      ensureHookSubscription();
      const createOptions = {
        sessionName,
        workingDirectory: opts.path,
        spawnArgv: launchSpawn.spawnArgv,
        spawnEnv: launchSpawn.spawnEnv,
        isolatedEnv: true,
      } as const;
      if (existingTerminalHost) {
        try {
          handle = hostResolution.adapter.relaunchExistingHost
            ? await hostResolution.adapter.relaunchExistingHost(existingTerminalHost.handle, createOptions)
            : await (async () => {
              await hostResolution.adapter.dispose(existingTerminalHost.handle);
              return hostResolution.adapter.createOrAttachHost(createOptions);
            })();
        } catch (error) {
          const liveness = await evaluateTerminalHostLivenessForRecovery(hostResolution.adapter, existingTerminalHost.handle);
          if (!isTerminalHostConfirmedDeadForRelaunch(liveness)) {
            throw error;
          }
          await discardExistingTerminalHost(existingTerminalHost, 'relaunch_failed_host_confirmed_dead');
          handle = await hostResolution.adapter.createOrAttachHost({
            ...createOptions,
            sessionName: fallbackSessionName,
          });
        }
      } else {
        handle = await hostResolution.adapter.createOrAttachHost(createOptions);
      }
    }
  } catch (error) {
    removeProcessSignalCleanup?.();
    removeProcessSignalCleanup = null;
    disposeReplayableHookSubscription(hookSubscription);
    if (spawn) await removeUnreadLaunchSpec(spawn);
    throw error;
  }
  if (processSignalAbortController.signal.aborted) {
    if (preHandleProcessSignalCleanupRan || !concreteHostDisposedByProcessSignal) {
      await disposeHostForProcessSignal(async () => {
        await hostResolution.adapter.dispose(handle);
        concreteHostDisposedByProcessSignal = true;
      });
    }
    removeProcessSignalCleanup?.();
    disposeReplayableHookSubscription(hookSubscription);
    if (spawn) await removeUnreadLaunchSpec(spawn);
    return;
  }
  const activeHandle = handle;
  const activeHookSubscription = hookSubscription ?? ensureHookSubscription();
  try {
    if (opts.registerTerminalComposerClearRuntimeControl) {
      const terminalComposerClearPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      if (terminalComposerClearPort) {
        const unregister = opts.registerTerminalComposerClearRuntimeControl(async (request) => {
          const result = await clearUserAuthorizedClaudeComposerDraft({
            port: terminalComposerClearPort,
          });
          const protocolResult = mapClaudeComposerClearResultToProtocolResult(result, request.sessionId);
          if (protocolResult.ok) {
            opts.onInFlightSteerAvailabilitySnapshot?.({ available: true, reason: null });
            wakeAfterTerminalComposerClear();
          }
          return protocolResult;
        });
        unregisterTerminalComposerClearRuntimeControl = typeof unregister === 'function' ? unregister : null;
      }
    }

    terminalAttachment = await persistTerminalHostAttachmentInfoIfAvailable({
      sessionId: opts.happySessionId,
      handle: activeHandle,
      persist: opts.persistTerminalHostAttachmentInfo ?? persistTerminalAttachmentInfoIfNeeded,
    });
    if (processSignalAbortController.signal.aborted) {
      return;
    }

    if (opts.dialogChoiceBroker) {
      const dialogChoiceControlPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      if (dialogChoiceControlPort) {
        dialogChoiceScreenProbe = createClaudeUnifiedDialogChoiceScreenProbe({
          broker: opts.dialogChoiceBroker,
          port: dialogChoiceControlPort,
          wait: waitMs,
          graceMs: opts.dialogOwnershipGraceMs ?? DEFAULT_DIALOG_OWNERSHIP_GRACE_MS,
          settleMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
          isDialogOwned: (dialogId) => runtimeControlBridge?.ownsDialog(dialogId) === true,
        });
      }
    }

    // Runtime-control integration (Lane E): when the feature gate is on and the host exposes a control
    // port, run verified TUI controls (model/effort/permission/plan mode) before each dependent prompt
    // injection. Gated-off / no-control-port → bridge stays null and injection is never gated (the
    // existing restart-notice path remains the behavior).
    const runtimeControlOptions = opts.tuiRuntimeControl;
    let currentInjectionMode: Mode = startupInput.mode;
    let currentInjectionDeliveryUserMessageLocalIds: readonly string[] = startupInput.userMessageLocalIds ?? [];
    // Lane X (incident cmq8y3nlx): bounded log of texts this runtime wrote into the TUI; the steer
    // evaluator uses it to classify a `user_draft` veto as our own leftover vs a genuine user draft.
    // C11: launchers pass a registry pre-seeded from the persisted prompt store so a RESPAWNED
    // runner also recognizes its predecessor's leftovers.
    // RESUME2 (runner pid 86645, 2026-06-12): controller-TYPED slash commands feed it too — a
    // typed-but-never-submitted `/effort medium` leftover otherwise classifies as a foreign draft
    // and deadlocks idle injection forever.
    const ownComposerTextLog = opts.ownComposerTexts ?? createClaudeOwnComposerTextLog();
    // Claude local-command XML/stdout rows are filtered globally by the scanner. This bookkeeper
    // only persists consumed markers from the raw transcript channel to prevent relaunch replay.
    let controlCommandEchoBookkeeper: ClaudeUnifiedControlCommandEchoBookkeeper | null = null;
    if (runtimeControlOptions?.featureEnabled === true) {
      runtimeControlBridge = runtimeControlOptions.createBridge?.() ?? null;
      if (!runtimeControlBridge) {
        const controlPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
        if (controlPort) {
          const controlEnv = spawnEnvForRuntimeControl
            ? Object.assign({}, spawnEnvForRuntimeControl) as NodeJS.ProcessEnv
            : process.env;
          const configDir = resolveClaudeConfigRootFromEnv(
            controlEnv,
            process.platform,
          );
          const commandEchoBookkeeper = createClaudeUnifiedControlCommandEchoBookkeeper({
            onConsumed: opts.onTranscriptMessageSuppressed,
          });
          controlCommandEchoBookkeeper = commandEchoBookkeeper;
          const tuiController = createClaudeUnifiedTuiControlController({
            port: controlPort,
            featureEnabled: true,
            settingsGuard: createClaudeSettingsGuard({ configDir }),
            onControlCommandTyped: (commandText) => commandEchoBookkeeper.recordTypedControlCommand(commandText),
            onControlCommandTextEntered: (commandText) => ownComposerTextLog.record(commandText),
          });
          runtimeControlBridge = createClaudeUnifiedRuntimeControlBridge({
            controller: tuiController,
            emitRuntimeConfigOutcome: runtimeControlOptions.emitRuntimeConfigOutcome,
            ...(runtimeControlOptions.sessionModeEmissionEnabled !== undefined
              ? { sessionModeEmissionEnabled: runtimeControlOptions.sessionModeEmissionEnabled }
              : {}),
            startupMode: startupInput.mode,
          });
        }
      }
      if (runtimeControlBridge && runtimeControlOptions.registerStatuslineRuntimeReconciler) {
        // Lane Y: statusline → lastVerified effective-truth feed. The applier dedups re-emits;
        // here we only hand the live bridge to the session-level statusline feed.
        const bridgeForStatusline = runtimeControlBridge;
        unregisterStatuslineRuntimeReconciler = runtimeControlOptions.registerStatuslineRuntimeReconciler(
          (metadata: ClaudeStatuslineRuntimeMetadata) => bridgeForStatusline.reconcileFromStatusline(metadata),
        );
      }
    }
    const blockedInjectionRetryMs = runtimeControlOptions?.blockedInjectionRetryMs
      ?? DEFAULT_RUNTIME_CONTROL_BLOCKED_INJECTION_RETRY_MS;
    const blockedApplyStarvationThreshold = Math.max(
      1,
      Math.trunc(runtimeControlOptions?.blockedApplyStarvationThreshold ?? DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD),
    );

    const readCanonicalTurnActiveForRuntimeControl = (): boolean => {
      try {
        return opts.isCanonicalTurnActive?.() ?? true;
      } catch {
        return true;
      }
    };

    // F2 starvation honesty: one bounded escalation per blocked delivery-apply episode (never a loop).
    const deliveryBlockedApplyStarvationTracker = createBlockedApplyStarvationTracker({
      threshold: blockedApplyStarvationThreshold,
      onStarvation: (info: BlockedApplyStarvationInfo) => runtimeControlOptions?.onBlockedApplyStarvation?.({
        isCanonicalTurnActive: readCanonicalTurnActiveForRuntimeControl(),
        ...info,
      }),
    });
    const metadataBlockedApplyStarvationTracker = createBlockedApplyStarvationTracker({
      threshold: blockedApplyStarvationThreshold,
      onStarvation: () => undefined,
    });

    if (runtimeControlOptions?.registerMetadataRuntimeModeApplier) {
      let metadataFallbackBaselineMode: Mode = startupInput.mode;
      let pendingMetadataRuntimeModeApply: Mode | null = null;
      let metadataRuntimeModeApplyInFlight: Promise<ClaudeUnifiedRuntimeControlApplyResult> | null = null;
      let metadataRuntimeModeApplyRetryTimer: ReturnType<typeof setTimeout> | null = null;
      let metadataRuntimeModeApplyStarvationOutcomeEmitted = false;
      const deferredMetadataRuntimeApplyResult = (): ClaudeUnifiedRuntimeControlApplyResult => ({
        promptMayProceed: false,
        attempted: false,
      });
      const clearMetadataRuntimeModeApplyRetryTimer = (): void => {
        if (!metadataRuntimeModeApplyRetryTimer) return;
        clearTimeout(metadataRuntimeModeApplyRetryTimer);
        metadataRuntimeModeApplyRetryTimer = null;
      };
      const emitMetadataRuntimeModeApplyStarvationOutcome = (
        mode: Mode,
        blockedReason: string | undefined,
      ): void => {
        if (metadataRuntimeModeApplyStarvationOutcomeEmitted) return;
        metadataRuntimeModeApplyStarvationOutcomeEmitted = true;
        const desired = mapEnhancedModeToDesiredRuntimeConfig(mode);
        const changes: Array<ClaudeUnifiedRuntimeConfigOutcomeEvent['changes'][number]> = [];
        if (desired.model !== undefined) {
          changes.push({ key: 'model', requested: desired.model, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (desired.reasoningEffort !== undefined) {
          changes.push({ key: 'reasoningEffort', requested: desired.reasoningEffort, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (desired.ultracode !== undefined) {
          changes.push({ key: 'launchOption', requested: 'ultracode', ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (desired.maxThinkingTokens !== undefined) {
          changes.push({ key: 'maxThinkingTokens', requested: desired.maxThinkingTokens, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (runtimeControlOptions.sessionModeEmissionEnabled === true && desired.agentModeId !== undefined) {
          changes.push({ key: 'sessionMode', requested: desired.agentModeId ?? null, ...(blockedReason ? { reason: blockedReason } : {}) });
        } else if (desired.permissionMode !== undefined) {
          changes.push({ key: 'permissionMode', requested: desired.permissionMode, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (changes.length === 0) return;
        runtimeControlOptions.emitRuntimeConfigOutcome({
          status: 'failed',
          timing: 'queued_until_safe_window',
          message: 'Claude Unified runtime changes are still blocked waiting for a safe terminal window.',
          changes,
        });
      };
      const schedulePendingMetadataRuntimeModeApplyRetry = (
        consecutiveBlockedApplies: number,
      ): void => {
        clearMetadataRuntimeModeApplyRetryTimer();
        metadataRuntimeModeApplyRetryTimer = setTimeout(() => {
          metadataRuntimeModeApplyRetryTimer = null;
          void retryPendingMetadataRuntimeModeApply().catch(() => undefined);
        }, resolveBlockedApplyRetryMs(consecutiveBlockedApplies, blockedInjectionRetryMs));
        metadataRuntimeModeApplyRetryTimer.unref?.();
      };
      const flushPendingMetadataRuntimeModeApply = async (): Promise<ClaudeUnifiedRuntimeControlApplyResult> => {
        if (metadataRuntimeModeApplyInFlight) return metadataRuntimeModeApplyInFlight;
        if (!pendingMetadataRuntimeModeApply || !runtimeControlBridge) {
          return deferredMetadataRuntimeApplyResult();
        }
        const apply = async (): Promise<ClaudeUnifiedRuntimeControlApplyResult> => {
          let lastResult = deferredMetadataRuntimeApplyResult();
          while (pendingMetadataRuntimeModeApply && runtimeControlBridge) {
            const modeForMetadataApply = pendingMetadataRuntimeModeApply;
            const result = await runtimeControlBridge.applyOutOfBand(modeForMetadataApply);
            lastResult = result;
            if (!result.promptMayProceed) {
              const consecutiveBlockedApplies = metadataBlockedApplyStarvationTracker.recordBlocked(result.blockedReason);
              if (consecutiveBlockedApplies >= blockedApplyStarvationThreshold) {
                emitMetadataRuntimeModeApplyStarvationOutcome(modeForMetadataApply, result.blockedReason);
              }
              schedulePendingMetadataRuntimeModeApplyRetry(consecutiveBlockedApplies);
              return result;
            }
            clearMetadataRuntimeModeApplyRetryTimer();
            metadataBlockedApplyStarvationTracker.reset();
            metadataRuntimeModeApplyStarvationOutcomeEmitted = false;
            metadataFallbackBaselineMode = modeForMetadataApply;
            if (pendingMetadataRuntimeModeApply === modeForMetadataApply) {
              pendingMetadataRuntimeModeApply = null;
            }
          }
          return lastResult;
        };
        const inFlight = apply().finally(() => {
          if (metadataRuntimeModeApplyInFlight === inFlight) {
            metadataRuntimeModeApplyInFlight = null;
          }
        });
        metadataRuntimeModeApplyInFlight = inFlight;
        return inFlight;
      };
      const retryPendingMetadataRuntimeModeApply = async (): Promise<void> => {
        if (!pendingMetadataRuntimeModeApply || !runtimeControlBridge) return;
        await flushPendingMetadataRuntimeModeApply();
      };
      observeSafeRuntimeBoundaryForMetadataApply = retryPendingMetadataRuntimeModeApply;
      const unregister = runtimeControlOptions.registerMetadataRuntimeModeApplier(async (modeForMetadataApply) => {
        if (runtimeControlBridge) {
          clearMetadataRuntimeModeApplyRetryTimer();
          metadataRuntimeModeApplyStarvationOutcomeEmitted = false;
          pendingMetadataRuntimeModeApply = modeForMetadataApply;
          return flushPendingMetadataRuntimeModeApply();
        }
        const events = buildClaudeUnifiedRuntimeControlDisabledOutcomeEvents({
          mode: modeForMetadataApply,
          baselineMode: metadataFallbackBaselineMode,
          sessionModeEmissionEnabled: runtimeControlOptions.sessionModeEmissionEnabled === true,
        });
        for (const event of events) {
          runtimeControlOptions.emitRuntimeConfigOutcome(event);
        }
        return {
          promptMayProceed: false,
          attempted: false,
        };
      });
      unregisterMetadataRuntimeModeApplier = typeof unregister === 'function'
        ? () => {
          clearMetadataRuntimeModeApplyRetryTimer();
          unregister();
        }
        : () => {
          clearMetadataRuntimeModeApplyRetryTimer();
        };
    }
    // The gate is armed only for the default controller wiring (which constructs the readiness
    // bridge below); a custom `createController` seam owns its own readiness.
    const startupReadinessGateArmed = !opts.createController;
    const inputInjection: TerminalInputInjectionV1 = {
      hostKind: hostResolution.adapter.kind,
      injectUserPrompt: async (input) => {
        if (startupReadinessGateArmed && !startupReadinessObservedForInjection) {
          return {
            status: 'deferred',
            reason: 'pane_initializing',
            retryAfterMs: 250,
          };
        }
        if (runtimeControlBridge) {
          // Apply verified runtime controls before the prompt is written. A blocked apply must NOT inject
          // under the wrong config; returning a `deferred` result hands the message back to the arbiter's
          // existing retry/terminalize machinery (the desired config is re-attempted on the next try).
          // Re-attempts back off exponentially (L5(a)): a fixed short retry hot-looped the apply path
          // when the safe window stayed blocked (incident cmq8y3nlx).
          const apply = await runtimeControlBridge.applyBeforePrompt(currentInjectionMode);
          if (!apply.promptMayProceed) {
            const consecutiveBlockedApplies = deliveryBlockedApplyStarvationTracker.recordBlocked(
              apply.blockedReason,
              {
                userMessageLocalIds: currentInjectionDeliveryUserMessageLocalIds,
              },
            );
            return {
              status: 'deferred',
              reason: 'terminal_busy',
              retryAfterMs: resolveBlockedApplyRetryMs(consecutiveBlockedApplies, blockedInjectionRetryMs),
              blocker: {
                kind: 'runtime_config_blocked',
                source: 'runtime_control',
                ...(apply.blockedReason !== undefined ? { blockedReason: apply.blockedReason } : {}),
              },
            };
          }
          deliveryBlockedApplyStarvationTracker.reset();
          runtimeControlOptions?.onBlockedApplyClear?.();
        }
        // Lane X: every text we attempt to write is recorded so a later leftover composer draft
        // can be exact-match classified as OUR OWN residue (vs an untouchable genuine user draft).
        ownComposerTextLog.record(input.text);
        const result = await hostResolution.adapter.injectUserPrompt(activeHandle, input);
        if (result.status === 'failed'
          && result.phase === 'during_write'
          && result.duplicateRisk !== 'none') {
          ownComposerTextLog.recordPossiblePartialResidue(input.text);
        }
        return result;
      },
    };
    removeProcessSignalCleanup?.();
    removeProcessSignalCleanup = bindProcessSignalCleanup({
      processSignals: opts.processSignals ?? process,
      abortController: processSignalAbortController,
      dispose: () => controller?.dispose() ?? hostResolution.adapter.dispose(activeHandle),
    });
    opts.setTurnInterrupt?.(() => hostResolution.adapter.interruptTurn(activeHandle));
    turnInterruptRegistered = true;
    const baseInputConsumer = createInputConsumer(first, opts.nextMessage);
    // Track the mode of the most recently pulled batch so the injection gate applies the runtime config
    // desired by the prompt that is about to be injected.
    const inputConsumer: ClaudeUnifiedInputConsumer<Mode> = runtimeControlBridge
      ? {
          async waitForNextInput(consumerOpts) {
            const batch = await baseInputConsumer.waitForNextInput(consumerOpts);
            if (batch) {
              currentInjectionMode = batch.mode;
              currentInjectionDeliveryUserMessageLocalIds = batch.userMessageLocalIds ?? [];
            }
            return batch;
          },
        }
      : baseInputConsumer;
    controller = await (opts.createController?.({
      hostAdapter: hostResolution.adapter,
      inputInjection,
      inputConsumer,
    }) ?? (() => {
      // Lane X: a dedicated control port for the bounded own-leftover composer clear (Escape on a
      // NON-generating screen only). Separate from the runtime-control controller's port — the
      // evaluator never routes through controller state. Shared with the pre-injection guard below.
      const steerDraftClearPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      const startupDialogControlPort = opts.createStartupDialogResolver
        ? (hostResolution.adapter.createControlPort?.(activeHandle) ?? null)
        : null;
      const resolveStartupDialog = startupDialogControlPort
        ? (opts.createStartupDialogResolver?.({
          controlPort: startupDialogControlPort,
          startupMode: startupInput.mode,
          isRuntimeControlInFlight: () => runtimeControlBridge?.isControlInFlight() === true,
        }) ?? undefined)
        : undefined;
      const captureInputStateForGuard = hostResolution.adapter.captureInputState;
      const promptInjector = createClaudeUnifiedPromptInjector<Mode>({
        inputInjection,
        telemetry,
        onDraftGuardStarvation: opts.onDraftGuardStarvation,
        onDraftGuardClear: opts.onDraftGuardClear,
        isCanonicalTurnActive: opts.isCanonicalTurnActive,
        // C11 (live-proven, runner pid 83791): never type an idle injection next to a leftover
        // composer draft. Own leftovers (respawn-seeded registry) are cleared; anything else
        // defers the injection untouched.
        ...(captureInputStateForGuard && steerDraftClearPort
          ? {
              composerDraftGuard: async () => {
                const result = await clearOwnLeftoverComposerDraft({
                  captureInputState: () => captureInputStateForGuard(activeHandle),
                  sendClearKey: async () => {
                    await steerDraftClearPort.sendSpecialKey('Escape');
                  },
                  ownComposerTexts: ownComposerTextLog,
                });
                const draftLength =
                  'screen' in result ? (result.screen.composerContent?.length ?? 0) : undefined;
                return {
                  status: result.status,
                  ...(result.status === 'cleared' ? { attempts: result.attempts } : {}),
                  ...(result.status === 'blocked_non_input_state' ? { blockedReason: result.blockedReason } : {}),
                  ...(draftLength !== undefined ? { draftLength } : {}),
                };
              },
            }
          : {}),
      });
      // In-flight steering (D19, incident cmq8171vw): a `ui_pending` prompt delivered mid-turn is
      // steered into the live TUI when the shared screen-state parser proves the screen is safe
      // (actively generating, no dialog/picker/draft); otherwise it keeps the bounded deferred path.
      // Lane Q: when the runtime-control bridge exists, a mode-carrying pending prompt may have
      // its permission/plan mode applied to the RUNNING turn (verified ShiftTab, probe Q-A) so the
      // text steers instead of deferring to turn end. No bridge -> unchanged refusal/defer behavior.
      const bridgeForInFlightModeApply = runtimeControlBridge;
      let arbiterForPromptCustody: ClaudeUnifiedInputArbiter<Mode> | null = null;
      const steerWiring = createClaudeUnifiedInFlightSteerEvaluator<Mode>({
        hostAdapter: hostResolution.adapter,
        handle: activeHandle,
        telemetry,
        initialPermissionMode: startupInput.mode.permissionMode,
        onPromptCustodyByTerminal: async (batch) => {
          await arbiterForPromptCustody?.observePromptCustodyByTerminal(batch);
        },
        onAvailabilitySnapshot: opts.onInFlightSteerAvailabilitySnapshot,
        onScreenObserved: observeTerminalScreen,
        ownComposerTexts: ownComposerTextLog,
        ...(steerDraftClearPort
          ? {
              clearOwnLeftoverDraft: async () => {
                await steerDraftClearPort.sendSpecialKey('Escape');
              },
            }
          : {}),
        onUserDraftStarvation: opts.onInFlightSteerUserDraftStarvation,
        ...(bridgeForInFlightModeApply
          ? {
              applyPermissionModeDeltaInFlight: (mode: Mode) =>
                bridgeForInFlightModeApply.applyPermissionModeForInFlightSteer(mode),
            }
          : {}),
      });
      inFlightSteerWiring = steerWiring;
      const arbiter = createClaudeUnifiedInputArbiter<Mode>({
        injectPrompt: promptInjector.injectPrompt,
        injectionRetryLimit: configuration.claudeUnifiedTerminalInjectionRetryLimit,
        injectionRetryBaseDelayMs: configuration.claudeUnifiedTerminalInjectionRetryBaseDelayMs,
        providerAcceptanceTimeoutMs:
          opts.providerAcceptanceTimeoutMs ??
          configuration.claudeUnifiedTerminalProviderAcceptanceTimeoutMs,
        evaluateInFlightSteer: steerWiring.evaluateInFlightSteer,
        onSteerAcceptanceArmed: steerWiring.onSteerAcceptanceArmed,
        isCanonicalTurnActive: opts.isCanonicalTurnActive,
        isPromptDeliveryAccepted: opts.isPromptDeliveryAccepted,
        onInjectionFailure: async (failure) => {
          const error = new ClaudeUnifiedTerminalInjectionFailureError(failure);
          const notifyTerminalInjectionFailure = async (logContext: string) => {
            try {
              return await opts.onTerminalInjectionFailure?.(error);
            } catch (notifyError) {
              logger.debug(logContext, notifyError);
              return undefined;
            }
          };
          if (failure.failureState === 'failed_terminal') {
            if (isDeterministicInvalidPromptTextFailure(failure)) {
              opts.onPromptTerminallyRejectedBeforeProvider?.({
                message: failure.batch.message,
                maxUserMessageSeq: failure.batch.maxUserMessageSeq ?? null,
                userMessageLocalIds: failure.batch.userMessageLocalIds ?? [],
                reason: 'invalid_prompt_text',
              });
              return await notifyTerminalInjectionFailure('[unified]: failed to surface Claude unified terminal invalid prompt text (non-fatal)');
            }
            if (failure.result.recoverable) {
              return await notifyTerminalInjectionFailure('[unified]: failed to surface Claude unified terminal recoverable injection failure (non-fatal)');
            }
            fatalRuntimeError ??= error;
            runtimeAbortController.abort(error);
            return;
          }
          return await notifyTerminalInjectionFailure('[unified]: failed to surface Claude unified terminal injection failure (non-fatal)');
        },
        onPromptInjected: (batch, acceptance, result) => {
          steerWiring.observeInjectedPrompt(batch, acceptance);
          acceptedPromptTranscriptDiscovery.recordAcceptedPrompt({
            message: batch.message,
            acceptedAtMs: result.at,
            deliveryIdentity: {
              localIds: batch.userMessageLocalIds ?? [],
              userMessageSeq: batch.maxUserMessageSeq ?? null,
            },
          });
          replayRecentAcceptedTranscriptCandidates();
          if (batch.mode === undefined) return undefined;
          endStartupHostLivenessGrace();
          return opts.onTerminalPromptInjected?.({
            message: batch.message,
            mode: batch.mode,
            acceptedAs: acceptance.acceptedAs,
            turnStateAtInjection: acceptance.turnStateAtInjection,
          });
        },
        onPromptAccepted: (batch) => {
          acceptedPromptTranscriptDiscovery.consumeAcceptedPromptByBatch({
            message: batch.message,
            maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
            userMessageLocalIds: batch.userMessageLocalIds ?? [],
          });
          opts.onPromptAcceptedByProvider?.({
            message: batch.message,
            maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
            userMessageLocalIds: batch.userMessageLocalIds ?? [],
          });
        },
        // F-1: a batch still inside the arbiter when it is disposed (failed_terminal park,
        // host-death unwind, graceful teardown) must return to the session queue, mirroring
        // the pump-level handback below — never silently dropped into a dead session.
        onUndeliverableBatches: (batches) => {
          // returnUnconsumedMessage unshifts to the queue head; reverse so FIFO order survives.
          for (const batch of [...batches].reverse()) {
            if (batch.mode === undefined) {
              logger.debug('[unified]: cannot requeue undeliverable arbiter batch without a mode');
              continue;
            }
            opts.returnUnconsumedMessage?.({
              message: batch.message,
              mode: batch.mode,
              maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
              userMessageLocalIds: batch.userMessageLocalIds ?? [],
            });
          }
        },
      });
      notifyTerminalComposerCleared = () => {
        arbiter.notifyTerminalComposerCleared();
      };
      if (terminalComposerClearedWakePending) {
        terminalComposerClearedWakePending = false;
        notifyTerminalComposerCleared();
      }
      arbiterForPromptCustody = arbiter;
      // Claude `/goal` injection seam (P1-E3/P1-E4): a goal command becomes a literal user turn
      // injected through the same arbiter as any prompt; the emitted `goal_status` attachment is
      // the source of truth, so nothing here writes goal state into metadata. `currentInjectionMode`
      // is read at injection time so the goal turn carries the live permission/plan mode.
      const injectGoalCommand = async (message: string): Promise<ClaudeGoalCommandDelivery> => {
        await arbiter.enqueueUiMessage({ message, mode: currentInjectionMode, origin: { kind: 'rpc' } });
        await arbiter.drainWhenSafe();
        // The strongest delivery state the arbiter can PROVE: the command was drained from the queue
        // and written to the terminal. It cannot prove provider acceptance, so we never claim more.
        return { kind: 'sent-to-terminal' };
      };
      if (opts.registerGoalRuntimeControl) {
        const unregister = opts.registerGoalRuntimeControl(
          createClaudeGoalRuntimeControls({
            injectGoalCommand,
            ...(opts.clearGoalWorkState ? { clearGoalWorkState: opts.clearGoalWorkState } : {}),
            ...(opts.recordGoalSetIntent ? { recordGoalSetIntent: opts.recordGoalSetIntent } : {}),
          }),
        );
        unregisterGoalRuntimeControl = typeof unregister === 'function' ? unregister : null;
      }
      const initialGoalObjective = opts.initialGoalObjective?.trim();
      if (initialGoalObjective) {
        // H4-CLI: a failed initial `/goal` injection must be SURFACED as a structured
        // runtime issue (the same seam prompt-injection failures use), not silently
        // swallowed. The goal_status attachment remains the source of truth, so a
        // failed inject never seeds a decorative goal — it just means Claude did not
        // start pursuing the requested objective, which the user must be told.
        void injectGoalCommand(buildClaudeGoalCommand({ type: 'set', objective: initialGoalObjective }))
          .catch(async (error) => {
            logger.debug('[unified]: failed to inject initial Claude goal', error);
            try {
              await opts.onTerminalInjectionFailure?.(error);
            } catch (surfaceError) {
              logger.debug('[unified]: failed to surface initial Claude goal injection failure (non-fatal)', surfaceError);
            }
          });
      }
      const recentAcceptedTranscriptCandidates: unknown[] = [];
      const rememberAcceptedTranscriptCandidates = (messages: readonly unknown[]): void => {
        for (const message of messages) {
          if (!isAcceptedPromptTranscriptCandidate(message)) continue;
          recentAcceptedTranscriptCandidates.push(message);
          while (recentAcceptedTranscriptCandidates.length > MAX_RECENT_ACCEPTED_TRANSCRIPT_CANDIDATES) {
            recentAcceptedTranscriptCandidates.shift();
          }
        }
      };
      let acceptedTranscriptConfirmationTail = Promise.resolve();
      const pendingAcceptedTranscriptMatchKeys = new Set<string>();
      const buildAcceptedTranscriptMatchKey = (match: Readonly<{
        acceptedPromptId: string;
        transcriptKey?: string | null | undefined;
      }>): string => `${match.acceptedPromptId}:${match.transcriptKey ?? 'unkeyed'}`;
      let confirmPromptAcceptedFromTranscript = (
        messages: readonly unknown[],
        confirmOpts?: Readonly<{ rememberUnmatched?: boolean | undefined }> | undefined,
      ): boolean => {
        if (confirmOpts?.rememberUnmatched !== false) {
          rememberAcceptedTranscriptCandidates(messages);
        }
        return false;
      };
      const replayRecentAcceptedTranscriptCandidates = (): boolean => (
        recentAcceptedTranscriptCandidates.length > 0
        && confirmPromptAcceptedFromTranscript([...recentAcceptedTranscriptCandidates], { rememberUnmatched: false })
      );
      confirmPromptAcceptedFromTranscript = (
        messages: readonly unknown[],
        confirmOpts?: Readonly<{ rememberUnmatched?: boolean | undefined }> | undefined,
      ): boolean => {
        const match = acceptedPromptTranscriptDiscovery.findMatchingTranscript(messages);
        if (!match) {
          if (confirmOpts?.rememberUnmatched !== false) {
            rememberAcceptedTranscriptCandidates(messages);
          }
          return false;
        }
        const matchKey = buildAcceptedTranscriptMatchKey(match);
        if (pendingAcceptedTranscriptMatchKeys.has(matchKey)) return true;
        pendingAcceptedTranscriptMatchKeys.add(matchKey);
        observeTrustedProviderProgress();
        acceptedTranscriptConfirmationTail = acceptedTranscriptConfirmationTail
          .catch(() => undefined)
          .then(async () => {
            try {
              const confirmed = await arbiter.confirmPromptAcceptedByProviderIf((batch) => (
                doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({ batch, match })
              ));
              if (confirmed) {
                acceptedPromptTranscriptDiscovery.consumeAcceptedPromptMatch(match);
              }
            } finally {
              pendingAcceptedTranscriptMatchKeys.delete(matchKey);
            }
          });
        void acceptedTranscriptConfirmationTail.catch(() => undefined);
        return true;
      };
      const confirmCompactBoundaryPromptAcceptedFromTranscript = (message: RawJSONLines): boolean => {
        if (!isCompactBoundaryTranscriptMessage(message)) return false;
        void arbiter.confirmPromptAcceptedByProviderIf((batch) => isCompactSlashCommandPrompt(batch.message)).catch(() => undefined);
        return true;
      };
      const pendingQueuePump = createClaudeUnifiedPendingQueuePump<Mode>({
        inputConsumer,
        arbiter,
        // A batch pulled during the death/dispose unwind must be returned to the
        // owner's queue, never silently dropped into a dead session.
        onUndeliverableBatch: (batch) => {
          opts.returnUnconsumedMessage?.({
            message: batch.message,
            mode: batch.mode,
            maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
            userMessageLocalIds: batch.userMessageLocalIds ?? [],
            providerAcceptancePending: batch.providerAcceptancePending === true,
          });
        },
        onProviderAcceptancePendingPrompt: (batch) => {
          ownComposerTextLog.record(batch.message);
          ownComposerTextLog.recordPossiblePartialResidue(batch.message, {
            minPrefixChars: PROVIDER_ACCEPTANCE_PENDING_PREFIX_RESIDUE_MIN_CHARS,
          });
        },
      });
      const observeMetadataApplySafeBoundary = async (): Promise<void> => {
        await observeSafeRuntimeBoundaryForMetadataApply?.();
      };
      const lifecycleBridge = activeHookSubscription.subscribe
        ? createClaudeUnifiedHookLifecycleBridge({
            subscribeClaudeSessionHooks: activeHookSubscription.subscribe,
            arbiter,
            completionQuiescenceMs:
              opts.lifecycleCompletionQuiescenceMs ?? configuration.claudeLocalTurnCompletionQuiescenceMs,
            onThinkingChange: opts.onThinkingChange,
            onReady: async () => {
              await observeMetadataApplySafeBoundary();
              await opts.onReady?.();
            },
            onUsageLimitDetails: opts.onUsageLimitDetails,
            onRuntimeAuthFailureEvent: opts.onRuntimeAuthFailureEvent,
            onProviderPromptStarted: opts.onProviderPromptStarted,
            onProviderPromptSubmitMetadata: runtimeControlBridge
              ? (metadata) => runtimeControlBridge?.reconcileFromPromptSubmitMetadata(metadata)
              : undefined,
            onProviderSessionStarted: observeProviderSessionStarted,
            onTrustedProviderProgress: observeTrustedProviderProgress,
            onPromptTurnTerminal: async (event) => {
              await observeMetadataApplySafeBoundary();
              await opts.onPromptTurnTerminal?.(event);
            },
            ...(dialogChoiceScreenProbe
              ? {
                  turnStallScreenProbe: {
                    quietMs: opts.dialogTurnStallScreenProbeQuietMs
                      ?? DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_QUIET_MS,
                    maxAttempts: opts.dialogTurnStallScreenProbeMaxAttempts
                      ?? DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_MAX_ATTEMPTS,
                    onStalled: async () => {
                      await dialogChoiceScreenProbe?.probe();
                    },
                  },
                }
              : {}),
            runtimeActivityPublisher: opts.runtimeActivityPublisher ?? null,
            onSessionEnd: (event) => {
              if (isClaudePromptInputExit(event)) {
                expectedPromptInputExit = true;
              }
            },
          })
        : undefined;
      const transcriptBridge = opts.onMessage || opts.onSessionFound
        ? createClaudeUnifiedTranscriptBridge({
            sessionId: opts.sessionId ?? null,
            transcriptPath: opts.transcriptPath,
            workingDirectory: opts.path,
            claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
            onMessage: opts.onMessage
              ? (message) => {
                  opts.onMessage?.(message);
                }
              : undefined,
            onTranscriptMessage: (message) => {
              if (!confirmPromptAcceptedFromTranscript([message])) {
                confirmCompactBoundaryPromptAcceptedFromTranscript(message);
              }
              lifecycleBridge?.observeTranscript(message);
            },
            onRawTranscriptValue: (value) => {
              confirmPromptAcceptedFromTranscript([value]);
              controlCommandEchoBookkeeper?.markConsumedTranscriptMessage(value);
              // Native Claude `/goal` source (plan H7): the goal_status attachment +
              // system/init slash_commands survive only on this raw channel (the
              // scanner drops them before `onMessage`). Forward to the launcher so it
              // feeds the centralized goal source; never reaches the visible transcript.
              opts.onRawTranscriptValue?.(value);
            },
            onSessionFound: opts.onSessionFound,
            loadCommittedClaudeJsonlMessageBaseline: opts.loadCommittedClaudeJsonlMessageBaseline,
            transcriptMissingWarningMs: configuration.claudeTranscriptMissingWarningMs,
            subscribeClaudeSessionHooks: activeHookSubscription.subscribe,
            classifyDiscoveredSession: ({ messages }) => (
              confirmPromptAcceptedFromTranscript(messages) ? 'main' : null
            ),
          })
        : undefined;
      return createClaudeUnifiedController({
        host: {
          evaluateLiveness: () => hostResolution.adapter.evaluateLiveness(activeHandle),
          dispose: () => hostResolution.adapter.dispose(activeHandle),
        },
        pendingQueuePump,
        arbiter,
        onFatalError: (error) => {
          fatalRuntimeError ??= error;
          runtimeAbortController.abort(error);
        },
        initialLivenessTimeoutMs:
          opts.initialHostLivenessTimeoutMs ??
          Math.min(configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs, 1_000),
        initialLivenessPollMs:
          opts.initialHostLivenessPollMs ??
          Math.min(configuration.claudeUnifiedTerminalStartupReadinessPollMs, 50),
        transcriptBridge: createCompositeBridge([
          createClaudeUnifiedTerminalReadinessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            arbiter,
            pollIntervalMs: configuration.claudeUnifiedTerminalStartupReadinessPollMs,
            timeoutMs: configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs,
            extendedTimeoutMs: configuration.claudeUnifiedTerminalStartupReadinessExtendedTimeoutMs,
            progressGraceMs: configuration.claudeUnifiedTerminalStartupReadinessProgressGraceMs,
            onStartupReady: () => {
              observeStartupReadyForInjection();
              endStartupHostLivenessGrace();
            },
            hasTrustedProviderProgress: () => trustedProviderProgressObserved,
            // SessionStart proves the host process is ALIVE (D17). It does not prove the interactive
            // composer is ready, so it extends the startup window instead of standing it down — a
            // slow-but-alive fresh session must not be killed before injection.
            hasHostAliveEvidence: () => providerSessionStartedObserved,
            canReportStartupReady: () => (
              allowEmptyStartupInputBeforeSessionStart
              || allowReadinessBeforeSessionStart
              || !opts.subscribeClaudeSessionHooks
              || Boolean(opts.sessionId || opts.transcriptPath)
              || providerSessionStartedObserved
            ),
            resolveStartupDialog,
            onScreenObserved: observeTerminalScreen,
            emitOutputReadiness: true,
          }),
          createClaudeUnifiedHostLivenessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            telemetry,
            pollIntervalMs: configuration.claudeUnifiedTerminalHostLivenessPollMs,
            probeFailureConfirmDeadMs: opts.hostLivenessProbeFailureConfirmDeadMs,
            startupGraceMs: configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs,
            startupGraceActive: () => startupHostLivenessGraceActive,
            isExpectedHostExit: (liveness) => expectedPromptInputExit && isCleanTerminalExit(liveness),
            onHostExited: () => {
              if (!runtimeAbortController.signal.aborted) {
                runtimeAbortController.abort('claude-unified-terminal-graceful-exit');
              }
            },
            onHostDead: (error) => {
              void publishHostDeadHealth(activeHandle, error.liveness);
              fatalRuntimeError ??= error;
              runtimeAbortController.abort(error);
            },
          }),
          lifecycleBridge,
          transcriptBridge,
        ]),
      });
    })());

    try {
      await controller.run();
    } catch (error) {
      if (error instanceof ClaudeUnifiedTerminalHostDeadError) {
        await publishHostDeadHealth(activeHandle, error.liveness);
        emitClaudeUnifiedHostDead(telemetry, {
          hostKind: activeHandle.kind,
          sessionName: activeHandle.sessionName,
          paneId: activeHandle.paneId,
          liveness: error.liveness,
        });
      }
      throw error;
    }
    if (terminalAttachment) {
      const happySessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
      if (happySessionId) {
        await (opts.clearSessionMarkerTerminalHostHealth ?? clearSessionMarkerTerminalHostHealth)({
          pid: process.pid,
          sessionId: happySessionId,
        }).catch((error) => {
          logger.debug('[unified]: failed to clear recovered terminal host health marker', error);
        });
      }
      await opts.onTerminalHostReady?.({ handle: activeHandle, terminal: terminalAttachment });
    }
    const waitSignals = [runtimeAbortController.signal, processSignalAbortController.signal];
    if (opts.signal) {
      waitSignals.push(opts.signal);
    }
    await waitForAnyAbort(waitSignals);
    if (fatalRuntimeError) {
      throw fatalRuntimeError;
    }
  } finally {
    if (turnInterruptRegistered) {
      opts.setTurnInterrupt?.(null);
    }
    removeProcessSignalCleanup?.();
    unregisterStatuslineRuntimeReconciler?.();
    unregisterMetadataRuntimeModeApplier?.();
    unregisterTerminalComposerClearRuntimeControl?.();
    unregisterGoalRuntimeControl?.();
    notifyTerminalComposerCleared = null;
    terminalComposerClearedWakePending = false;
    if (runtimeControlBridge) {
      await runtimeControlBridge.dispose().catch((error) => {
        logger.debug('[unified]: failed to dispose Claude unified runtime-control bridge (non-fatal)', error);
      });
    }
    dialogChoiceScreenProbe?.dispose();
    dialogChoiceScreenProbe = null;
    inFlightSteerWiring?.dispose();
    if (controller) {
      await controller.dispose();
    } else if (!concreteHostDisposedByProcessSignal) {
      await hostResolution.adapter.dispose(activeHandle);
    }
    await removeTerminalHostAttachmentInfoIfAvailable({
      sessionId: opts.happySessionId,
      terminal: terminalAttachment,
      remove: opts.removeTerminalHostAttachmentInfo ?? removeDefaultTerminalHostAttachmentInfo,
    }).catch((error) => {
      logger.debug('[unified]: failed to remove Claude unified terminal attachment info', error);
    });
    activeHookSubscription.dispose();
  }
}

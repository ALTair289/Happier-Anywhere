import { createSessionScanner, type SessionScanner } from '../utils/sessionScanner';
import type { CommittedClaudeJsonlMessageBaseline } from '../utils/claudeJsonlMessageKey';
import type { RawJSONLines } from '../types';
import { readClaudeTranscriptTurnSignal } from '../localControl/readClaudeTranscriptTurnSignal';
import { isSidechainSessionHook } from '../utils/sessionHookAttribution';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { getProjectPath } from '../utils/path';

// Allowance for clock skew between Claude JSONL row timestamps (runner machine clock) and the
// server commit times that bound the committed-keys baseline coverage window (Lane N4). A
// genuinely-missed row is written minutes before the respawn while the coverage window usually
// reaches hours back, so a generous allowance keeps backfill intact.
const COMMITTED_BASELINE_COVERAGE_SKEW_MS = 10 * 60_000;
import type { SessionHookData } from '../utils/startHookServer';
import type { ClaudeUnifiedSessionHookSubscription } from './createClaudeUnifiedHookLifecycleBridge';
import type { ClaudeUnifiedStartableDisposable } from './_types';
import { createJsonlFollowController, type JsonlFollowController } from '@/agent/localControl/jsonlFollowController';
import type { JsonlFollowerMetricEvent } from '@/agent/localControl/jsonlFollowMetrics';
import { createClaudeJsonlResetReplaySuppressor } from '../utils/claudeJsonlReplaySuppression';
import { wasClaudeSessionHookIdentityReported } from './createReplayableHookSubscription';

type ClaudeUnifiedTranscriptBridgeSessionFound = (sessionId: string, data: SessionHookData) => void;

function readHookEventName(data: SessionHookData): string {
  const raw = data.hook_event_name ?? data.hookEventName;
  return typeof raw === 'string' ? raw : '';
}

function readHookString(data: SessionHookData, snakeKey: string, camelKey: string): string | null {
  const raw = (data as Record<string, unknown>)[snakeKey] ?? (data as Record<string, unknown>)[camelKey];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function readSessionStartInfo(data: SessionHookData): Readonly<{
  sessionId: string;
  transcriptPath: string | null;
  source: string | null;
}> | null {
  if (readHookEventName(data) !== 'SessionStart') return null;
  const sessionId = readHookString(data, 'session_id', 'sessionId');
  if (!sessionId) return null;
  return {
    sessionId,
    transcriptPath: readHookString(data, 'transcript_path', 'transcriptPath'),
    source: readHookString(data, 'source', 'source'),
  };
}

type ClaudeUnifiedSessionStartInfo = NonNullable<ReturnType<typeof readSessionStartInfo>>;

type PendingClaudeUnifiedSessionStart = Readonly<{
  data: SessionHookData;
  receivedAtMs: number;
  sessionInfo: ClaudeUnifiedSessionStartInfo;
}>;

function disposeSubscription(dispose: (() => void) | null): void {
  if (!dispose) return;
  dispose();
}

function readTranscriptString(message: RawJSONLines, key: string): string | null {
  const raw = (message as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function readTranscriptTimestampMs(message: RawJSONLines): number | null {
  const timestamp = readTranscriptString(message, 'timestamp');
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldForwardResumeTranscriptToLifecycle(
  message: RawJSONLines,
  resumeLiveTranscriptAfterMsBySessionId: ReadonlyMap<string, number>,
): boolean {
  const sessionId = readTranscriptString(message, 'sessionId');
  if (!sessionId) return true;
  const liveAfterMs = resumeLiveTranscriptAfterMsBySessionId.get(sessionId);
  if (liveAfterMs === undefined) return true;
  const timestampMs = readTranscriptTimestampMs(message);
  if (timestampMs === null) return true;
  return timestampMs >= liveAfterMs;
}

function shouldForwardFreshResumeTranscriptToMessage(
  message: RawJSONLines,
  resumeLiveTranscriptAfterMsBySessionId: ReadonlyMap<string, number>,
): boolean {
  const sessionId = readTranscriptString(message, 'sessionId');
  if (!sessionId) return true;
  const liveAfterMs = resumeLiveTranscriptAfterMsBySessionId.get(sessionId);
  if (liveAfterMs === undefined) return true;
  const timestampMs = readTranscriptTimestampMs(message);
  if (timestampMs === null) return false;
  return timestampMs >= liveAfterMs;
}

function isFailedTurnTerminalTranscript(message: RawJSONLines): boolean {
  const signal = readClaudeTranscriptTurnSignal(message);
  return signal?.type === 'turn_terminal' && signal.reason === 'failed';
}

function shouldSuppressPriorEraFailedTurnVisibleReplay(
  message: RawJSONLines,
  lifecycleOwnedByCurrentRunner: boolean,
): boolean {
  return !lifecycleOwnedByCurrentRunner && isFailedTurnTerminalTranscript(message);
}

function isFreshHookDrivenSession(opts: Readonly<{
  sessionId: string | null;
  transcriptPath?: string | null | undefined;
}>): boolean {
  const transcriptPath = typeof opts.transcriptPath === 'string' && opts.transcriptPath.trim().length > 0
    ? opts.transcriptPath.trim()
    : null;
  return opts.sessionId === null && !transcriptPath;
}

function readKnownResumeTranscriptPath(opts: Readonly<{
  sessionId: string | null;
  transcriptPath?: string | null | undefined;
  workingDirectory: string;
  claudeConfigDir?: string | null | undefined;
}>): Readonly<{ path: string; source: 'explicit' | 'canonical' }> | null {
  const explicitTranscriptPath =
    typeof opts.transcriptPath === 'string' && opts.transcriptPath.trim().length > 0
      ? opts.transcriptPath.trim()
      : null;
  if (explicitTranscriptPath) {
    return { path: explicitTranscriptPath, source: 'explicit' };
  }
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.trim().length > 0
      ? opts.sessionId.trim()
      : null;
  if (!sessionId) return null;
  return {
    path: join(getProjectPath(opts.workingDirectory, opts.claudeConfigDir ?? null), `${sessionId}.jsonl`),
    source: 'canonical',
  };
}

export function createClaudeUnifiedTranscriptBridge(opts: Readonly<{
  sessionId: string | null;
  transcriptPath?: string | null | undefined;
  workingDirectory: string;
  claudeConfigDir?: string | null | undefined;
  onMessage?: ((message: RawJSONLines) => void) | undefined;
  onTranscriptMessage?: ((message: RawJSONLines) => void) | undefined;
  onRawTranscriptValue?: ((
    value: unknown,
    observation: Readonly<{ historicalReplay: boolean }>,
  ) => void) | undefined;
  onLiveProviderTaskJsonlValue?: ((input: Readonly<{
    sessionId: string;
    value: unknown;
  }>) => void) | undefined;
  onLiveProviderTaskObservationLost?: ((input: Readonly<{
    sessionId: string;
    reason: string;
  }>) => void) | undefined;
  /**
   * Returns true only when a trusted transcript row proves that Happier's exact accepted prompt
   * reached the primary Claude session. The bridge then re-reports the original SessionStart so
   * the canonical session metadata owner can re-check the now-materialized transcript path.
   */
  proveAcceptedMainTranscript?: ((value: unknown) => boolean) | undefined;
  onSessionFound?: ClaudeUnifiedTranscriptBridgeSessionFound | undefined;
  onTranscriptMissing?: ((info: { sessionId: string; filePath: string }) => void) | undefined;
  transcriptMissingWarningMs?: number | undefined;
  subscribeClaudeSessionHooks?: ClaudeUnifiedSessionHookSubscription | undefined;
  /**
   * Committed Claude JSONL dedupe baseline for resume replay (Lane N4). The baseline must be
   * loaded BEFORE the scanner replays initial rows; a load FAILURE fails closed (no
   * replay-as-new), and a partial coverage window suppresses replay of rows older than the
   * window (they cannot be proven uncommitted).
   */
  loadCommittedClaudeJsonlMessageBaseline?: (() =>
    | Promise<CommittedClaudeJsonlMessageBaseline>
    | CommittedClaudeJsonlMessageBaseline) | undefined;
  classifyDiscoveredSession?: ((params: {
    sessionId: string;
    filePath: string;
    messages: readonly RawJSONLines[];
  }) => 'ignore' | 'diagnostic' | 'main' | null | undefined) | undefined;
}>): ClaudeUnifiedStartableDisposable {
  let disposed = false;
  let scanner: Awaited<SessionScanner> | null = null;
  let unsubscribe: (() => void) | null = null;
  const resumeLiveTranscriptAfterMsBySessionId = new Map<string, number>();
  const freshResumeLiveMessageAfterMsBySessionId = new Map<string, number>();
  const pendingSessionStarts: PendingClaudeUnifiedSessionStart[] = [];
  const promotedDiscoveredMainSessionIds = new Set<string>();
  const freshHookDrivenSession = isFreshHookDrivenSession(opts);
  const knownResumeSessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.trim().length > 0
      ? opts.sessionId.trim()
      : null;
  const knownResumeTranscript = readKnownResumeTranscriptPath(opts);
  const knownResumeTranscriptPath = knownResumeTranscript?.path ?? null;
  let knownResumeRawFollower: JsonlFollowController | null = null;
  const knownResumeRawFollowerReplaySuppressor = createClaudeJsonlResetReplaySuppressor();
  let activeTrustedSessionStart: Readonly<{
    data: SessionHookData;
    sessionInfo: ClaudeUnifiedSessionStartInfo;
  }> | null = null;
  let acceptedMainTranscriptProvenForSessionId: string | null = null;

  const recordSessionStartBaselines = (
    sessionInfo: ClaudeUnifiedSessionStartInfo,
    receivedAtMs: number,
  ) => {
    if (sessionInfo.source !== 'resume') return;
    resumeLiveTranscriptAfterMsBySessionId.set(sessionInfo.sessionId, receivedAtMs);
    if (freshHookDrivenSession) {
      freshResumeLiveMessageAfterMsBySessionId.set(sessionInfo.sessionId, receivedAtMs);
    }
  };

  const applySessionStart = (
    sessionInfo: ClaudeUnifiedSessionStartInfo,
    data: SessionHookData,
    receivedAtMs: number,
  ) => {
    if (disposed) return;
    const previousSessionInfo = activeTrustedSessionStart?.sessionInfo;
    if (
      !previousSessionInfo
      || previousSessionInfo.sessionId !== sessionInfo.sessionId
      || previousSessionInfo.transcriptPath !== sessionInfo.transcriptPath
    ) {
      acceptedMainTranscriptProvenForSessionId = null;
    }
    activeTrustedSessionStart = { data, sessionInfo };
    recordSessionStartBaselines(sessionInfo, receivedAtMs);
    if (!wasClaudeSessionHookIdentityReported(data)) {
      opts.onSessionFound?.(sessionInfo.sessionId, data);
    }

    if (!scanner) {
      pendingSessionStarts.push({ data, receivedAtMs, sessionInfo });
      return;
    }

    scanner.onNewSession({
      sessionId: sessionInfo.sessionId,
      transcriptPath: sessionInfo.transcriptPath,
    });
  };

  const observeTrustedRawTranscriptValue = (
    value: unknown,
    observation: Readonly<{ historicalReplay: boolean }>,
  ): void => {
    opts.onRawTranscriptValue?.(value, observation);
    if (observation.historicalReplay) return;
    const activeSessionStart = activeTrustedSessionStart;
    if (!opts.proveAcceptedMainTranscript) return;
    // A canonical known-resume follower is already bound to the exact requested Claude session
    // and starts at the current EOF, so its fresh authenticated rows may prove exact prompt
    // acceptance even when an adopted provider never emits a new SessionStart. Once a real
    // SessionStart arrives, that live identity takes precedence and the old follower cannot settle.
    const trustedSessionId = activeSessionStart?.sessionInfo.sessionId ?? knownResumeSessionId;
    if (!trustedSessionId) return;
    const sessionId = readTranscriptString(value as RawJSONLines, 'sessionId');
    if (sessionId !== trustedSessionId) return;
    if (!opts.proveAcceptedMainTranscript(value)) return;

    // Acceptance proof is per exact Pending prompt and must keep observing every authenticated
    // primary-session raw row. Only the metadata re-report is one-shot for a Claude session.
    if (acceptedMainTranscriptProvenForSessionId === sessionId) return;

    acceptedMainTranscriptProvenForSessionId = sessionId;
    if (activeSessionStart) {
      opts.onSessionFound?.(sessionId, activeSessionStart.data);
    }
  };

  const observeLiveProviderTaskJsonlValue = (
    input: Readonly<{ sessionId: string; value: unknown }>,
  ): void => {
    const row = input.value && typeof input.value === 'object' && !Array.isArray(input.value)
      ? input.value as Readonly<Record<string, unknown>>
      : null;
    const rawSessionId = row?.session_id ?? row?.sessionId;
    const rowSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (!rowSessionId || rowSessionId !== input.sessionId) return;
    opts.onLiveProviderTaskJsonlValue?.(input);
  };

  const startKnownResumeRawFollower = async (): Promise<void> => {
    if (
      !knownResumeSessionId
      || !knownResumeTranscriptPath
      || (!opts.onRawTranscriptValue && !opts.proveAcceptedMainTranscript)
    ) return;
    if (knownResumeRawFollower) return;
    logger.debug('[unified]: known resume raw transcript follower starting', {
      sessionId: knownResumeSessionId,
      transcriptPath: knownResumeTranscriptPath,
      transcriptPathSource: knownResumeTranscript?.source ?? 'none',
    });
    const startOffsetBytes = await stat(knownResumeTranscriptPath).then(
      (snapshot) => snapshot.size,
      () => 0,
    );
    const follower = createJsonlFollowController({
      filePath: knownResumeTranscriptPath,
      startOffsetBytes,
      metrics: {
        emit: (event: JsonlFollowerMetricEvent) => {
          if (event.type !== 'file_reset') return;
          const suppressBeforeMs = knownResumeRawFollowerReplaySuppressor.markReset();
          logger.debug('[unified]: known resume raw transcript follower reset; suppressing replay-prone rows', {
            sessionId: knownResumeSessionId,
            reason: event.reason,
            suppressBeforeMs,
          });
        },
      },
      onJson: (value) => {
        if (disposed) return;
        if (knownResumeRawFollowerReplaySuppressor.shouldSuppress(value)) return;
        observeTrustedRawTranscriptValue(value, { historicalReplay: false });
      },
      onError: (error) => {
        logger.debug('[unified]: known resume raw transcript follower error:', error);
      },
    });
    knownResumeRawFollower = follower;
    await follower.start();
    if (disposed || knownResumeRawFollower !== follower) {
      await follower.stop();
    }
  };

  const flushPendingSessionStarts = () => {
    if (!scanner) return;
    for (const pending of pendingSessionStarts.splice(0)) {
      recordSessionStartBaselines(pending.sessionInfo, pending.receivedAtMs);
      scanner.onNewSession({
        sessionId: pending.sessionInfo.sessionId,
        transcriptPath: pending.sessionInfo.transcriptPath,
      });
    }
  };

  return {
    async start() {
      if (disposed || scanner) return;
      const waitForSessionStartHook = Boolean(opts.subscribeClaudeSessionHooks);
      if (opts.subscribeClaudeSessionHooks && !unsubscribe) {
        logger.debug('[unified]: Claude SessionStart hook subscription registered', {
          knownResumeSessionId,
          knownResumeTranscriptPath,
          knownResumeTranscriptPathSource: knownResumeTranscript?.source ?? 'none',
        });
        unsubscribe = opts.subscribeClaudeSessionHooks((data) => {
          // A4-MED-2: a subagent (sidechain) SessionStart must never re-key the transcript /
          // resume identity — same shared gate the hook lifecycle bridge uses.
          if (isSidechainSessionHook(data)) {
            if (readHookEventName(data) === 'SessionStart') {
              logger.debug('[unified]: ignoring sidechain Claude SessionStart hook');
            }
            return;
          }
          const sessionInfo = readSessionStartInfo(data);
          if (!sessionInfo && readHookEventName(data) === 'SessionStart') {
            logger.debug('[unified]: ignoring malformed Claude SessionStart hook', {
              hasSessionId: Boolean(readHookString(data, 'session_id', 'sessionId')),
              hasTranscriptPath: Boolean(readHookString(data, 'transcript_path', 'transcriptPath')),
            });
          }
          if (!sessionInfo) return;
          logger.debug('[unified]: Claude SessionStart hook received', {
            sessionId: sessionInfo.sessionId,
            hasTranscriptPath: Boolean(sessionInfo.transcriptPath),
            source: sessionInfo.source,
            knownResumeSessionId,
          });
          applySessionStart(sessionInfo, data, Date.now());
        }) ?? null;
      }
      let committedClaudeJsonlMessageKeys: ReadonlySet<string> = new Set<string>();
      let replaySuppressRowsBeforeMs: number | null = null;
      const resumesKnownClaudeSession = Boolean(opts.sessionId || opts.transcriptPath);
      if (waitForSessionStartHook) {
        await startKnownResumeRawFollower();
        try {
          const baseline = await Promise.resolve(opts.loadCommittedClaudeJsonlMessageBaseline?.())
            ?? { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null };
          committedClaudeJsonlMessageKeys = baseline.keys;
          if (!baseline.complete && typeof baseline.oldestCoveredAtMs === 'number' && Number.isFinite(baseline.oldestCoveredAtMs)) {
            replaySuppressRowsBeforeMs = baseline.oldestCoveredAtMs - COMMITTED_BASELINE_COVERAGE_SKEW_MS;
          }
        } catch (error) {
          // Fail CLOSED for resumes (Lane N4, incident pid-44935): without a baseline we cannot
          // distinguish committed history from missed rows, and replay-as-new floods the session
          // with duplicates. Suppressing the initial snapshot only degrades downtime backfill,
          // never correctness; live rows keep flowing. Fresh sessions have no committed history
          // to duplicate, so they keep the normal replay.
          if (resumesKnownClaudeSession) {
            replaySuppressRowsBeforeMs = Number.POSITIVE_INFINITY;
          }
          logger.debug('[unified]: committed Claude JSONL baseline unavailable; suppressing resume replay (fail-closed)', error);
        }
      }
      if (disposed) {
        pendingSessionStarts.length = 0;
        return;
      }
      const prebindKnownResumeTranscript = Boolean(
        waitForSessionStartHook
        && knownResumeSessionId
        && knownResumeTranscriptPath
        && knownResumeTranscript?.source === 'canonical',
      );
      const nextScanner = await createSessionScanner({
        sessionId: waitForSessionStartHook
          ? (prebindKnownResumeTranscript ? knownResumeSessionId : null)
          : opts.sessionId,
        transcriptPath: waitForSessionStartHook
          ? (prebindKnownResumeTranscript ? knownResumeTranscriptPath : null)
          : opts.transcriptPath,
        claudeConfigDir: opts.claudeConfigDir,
        workingDirectory: opts.workingDirectory,
        onMessage: (message) => {
          const lifecycleOwnedByCurrentRunner = shouldForwardResumeTranscriptToLifecycle(
            message,
            resumeLiveTranscriptAfterMsBySessionId,
          );
          if (
            shouldForwardFreshResumeTranscriptToMessage(message, freshResumeLiveMessageAfterMsBySessionId)
            && !shouldSuppressPriorEraFailedTurnVisibleReplay(message, lifecycleOwnedByCurrentRunner)
          ) {
            opts.onMessage?.(message);
          }
          if (lifecycleOwnedByCurrentRunner) {
            opts.onTranscriptMessage?.(message);
          }
        },
        onRawJsonlValue: opts.onRawTranscriptValue || opts.proveAcceptedMainTranscript
          ? observeTrustedRawTranscriptValue
          : undefined,
        onLiveJsonlValue: opts.onLiveProviderTaskJsonlValue
          ? observeLiveProviderTaskJsonlValue
          : undefined,
        onLiveJsonlObservationLost: opts.onLiveProviderTaskObservationLost,
        onTranscriptMissing: opts.onTranscriptMissing,
        transcriptMissingWarningMs: opts.transcriptMissingWarningMs,
        initialProcessedMessageKeys: committedClaudeJsonlMessageKeys,
        replayInitialMessages: waitForSessionStartHook && !prebindKnownResumeTranscript,
        replaySuppressRowsBeforeMs,
        discoverNewSessions: waitForSessionStartHook && !knownResumeSessionId && !opts.transcriptPath,
        bindToFirstSession: waitForSessionStartHook,
        bindDiscoveredSessions: !waitForSessionStartHook,
        classifyDiscoveredSession: opts.classifyDiscoveredSession,
        onDiscoveredMainSession: (params) => {
          if (promotedDiscoveredMainSessionIds.has(params.sessionId)) return;
          promotedDiscoveredMainSessionIds.add(params.sessionId);
          // Exact accepted-prompt transcript matching is the hookless identity fallback for a
          // terminal session whose SessionStart hook never activated. Promotion occurs only
          // after the scanner confirms this candidate won binding, so a simultaneous trusted
          // SessionStart cannot be overwritten by discovery.
          opts.onSessionFound?.(params.sessionId, {
            session_id: params.sessionId,
            transcript_path: params.filePath,
            cwd: opts.workingDirectory,
            source: 'transcript_discovery',
          });
        },
      });
      if (disposed) {
        pendingSessionStarts.length = 0;
        await nextScanner.cleanup();
        return;
      }
      scanner = nextScanner;
      flushPendingSessionStarts();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      disposeSubscription(unsubscribe);
      unsubscribe = null;
      pendingSessionStarts.length = 0;
      promotedDiscoveredMainSessionIds.clear();
      activeTrustedSessionStart = null;
      acceptedMainTranscriptProvenForSessionId = null;
      await scanner?.cleanup();
      scanner = null;
      await knownResumeRawFollower?.stop();
      knownResumeRawFollower = null;
    },
  };
}

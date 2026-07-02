import {
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';
import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';
import { logger as defaultLogger } from '@/ui/logger';
import {
  isRetryableConnectedServiceRuntimeAuthFailureReportDelivery,
  resolveConnectedServiceRuntimeAuthFailureStatusMessage,
} from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';
import {
  normalizeConnectedServiceRuntimeAuthRecoveryProjection,
  type ConnectedServiceRuntimeAuthRecoveryProjection,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';
import { buildStableRuntimeAuthFailureReportDedupeKey } from './runtimeAuthFailureReportIdentity';
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  removeRuntimeAuthFailureReportOutboxItem,
  resolveRuntimeAuthFailureReportOutboxKey,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
import { scheduleRuntimeAuthFailureReportOutboxDrainToDaemon } from './reportOutbox/runtimeAuthFailureReportOutboxDrainScheduler';

type RuntimeAuthFailureNotifyBody = Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  classification: unknown;
}>;

type RuntimeAuthFailureNotifyOptions = Readonly<{
  timeoutMs?: number;
}>;

type RuntimeAuthFailureNotify = (
  body: RuntimeAuthFailureNotifyBody,
  options?: RuntimeAuthFailureNotifyOptions,
) => Promise<unknown>;

type RuntimeAuthFailureLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

type RuntimeAuthFailureReportOutboxDrainScheduler = (input: Readonly<{
  outboxDir?: string;
}>) => void;

export type ConnectedServiceRuntimeAuthFailureDaemonReport = Readonly<{
  handled: boolean;
  report: unknown | null;
  statusCode: string | null;
  statusMessage: string | null;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  uxDiagnostic?: ConnectedServiceRuntimeAuthRecoveryProjection['uxDiagnostic'];
  projection?: ConnectedServiceRuntimeAuthRecoveryProjection;
}>;

export const CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS = 120_000;

// Incident Jun-11 H-C / FIX-2: one failed turn is observed by multiple independent triggers
// (e.g. Claude's StopFailure hook, the SDK inbound loop, and the bridge transcript observer),
// each of which calls this shared report path. Dedupe lives HERE — the single owner in front
// of the daemon — keyed on STABLE identity only (no Date.now-derived retryAfterMs), with a
// short TTL window. Concurrent duplicates coalesce onto the in-flight daemon call.
const RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS = 15_000;

type RuntimeAuthFailureReportDedupeEntry = Readonly<{
  reportedAtMs: number;
  result: Promise<ConnectedServiceRuntimeAuthFailureDaemonReport>;
}>;

const recentRuntimeAuthFailureReportsByStableKey = new Map<string, RuntimeAuthFailureReportDedupeEntry>();

export function resetConnectedServiceRuntimeAuthFailureReportDedupeForTests(): void {
  recentRuntimeAuthFailureReportsByStableKey.clear();
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function pruneStaleRuntimeAuthFailureReportDedupeEntries(nowMs: number): void {
  for (const [key, entry] of recentRuntimeAuthFailureReportsByStableKey.entries()) {
    if (nowMs - entry.reportedAtMs > RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS) {
      recentRuntimeAuthFailureReportsByStableKey.delete(key);
    }
  }
}

export async function reportConnectedServiceRuntimeAuthFailureToDaemon(input: Readonly<{
	  sessionId: string;
	  switchesThisTurn?: number;
	  resumePromptMode?: unknown;
	  classification: unknown;
	  notify?: RuntimeAuthFailureNotify;
	  logger?: RuntimeAuthFailureLogger;
  logPrefix?: string;
  reportOutboxDir?: string;
  scheduleOutboxDrain?: RuntimeAuthFailureReportOutboxDrainScheduler;
  nowMs?: () => number;
}>): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
  const notify = input.notify ?? notifyDaemonConnectedServiceRuntimeAuthFailure;
  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const scheduleOutboxDrain = input.scheduleOutboxDrain ?? ((args: Readonly<{ outboxDir?: string }>) => {
    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      ...(args.outboxDir ? { outboxDir: args.outboxDir } : {}),
      logger,
      logPrefix,
    });
  });
  const resumePromptMode = readResumePromptMode(input.resumePromptMode);
  const reportBody = {
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn ?? 0,
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification: input.classification,
  };

  async function enqueueOutboxBestEffort(): Promise<void> {
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        report: reportBody,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      });
      if (result.status === 'enqueued') {
        scheduleOutboxDrain({
          ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        });
      }
    } catch (error) {
      logger.debug(`${logPrefix} Failed to enqueue connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function removeOutboxBestEffort(): Promise<void> {
    const reportKey = resolveRuntimeAuthFailureReportOutboxKey(reportBody);
    if (!reportKey) return;
    try {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        reportKey,
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to remove connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function performReport(): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
    try {
      const report = await notify(reportBody, {
        timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
      });
      const statusNote = resolveConnectedServiceRuntimeAuthFailureStatusMessage(report);
      const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
        report,
        statusNote,
      });
      if (projection.handled) {
        await removeOutboxBestEffort();
      } else if (isRetryableConnectedServiceRuntimeAuthFailureReportDelivery(report)) {
        await enqueueOutboxBestEffort();
      }
	      return {
	        handled: projection.handled,
	        report,
	        statusCode: projection.statusCode,
	        statusMessage: projection.statusMessage,
	        ...(resumePromptMode ? { resumePromptMode } : {}),
	        ...(projection.uxDiagnostic ? { uxDiagnostic: projection.uxDiagnostic } : {}),
	        projection,
	      };
    } catch (error) {
      await enqueueOutboxBestEffort();
      logger.debug(`${logPrefix} Failed to report connected-service runtime auth failure to daemon (non-fatal)`, error);
	      return {
	        handled: false,
	        report: null,
	        statusCode: null,
	        statusMessage: null,
	        ...(resumePromptMode ? { resumePromptMode } : {}),
	      };
    }
  }

  const nowMs = (input.nowMs ?? Date.now)();
	  const dedupeKey = buildStableRuntimeAuthFailureReportDedupeKey({
	    sessionId: input.sessionId,
	    switchesThisTurn: input.switchesThisTurn ?? 0,
	    resumePromptMode,
	    classification: input.classification,
	  });
  if (!dedupeKey) {
    return await performReport();
  }
  pruneStaleRuntimeAuthFailureReportDedupeEntries(nowMs);
  const recent = recentRuntimeAuthFailureReportsByStableKey.get(dedupeKey);
  if (recent && nowMs - recent.reportedAtMs <= RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS) {
    logger.debug(`${logPrefix} Suppressed duplicate connected-service runtime auth failure report (stable-key dedupe)`);
    return await recent.result;
  }
  const result = performReport();
  recentRuntimeAuthFailureReportsByStableKey.set(dedupeKey, {
    reportedAtMs: nowMs,
    result,
  });
  // A FAILED delivery (notify threw → report:null) must not hold the window: concurrent
  // duplicates coalesce onto the in-flight call, but once it settles unreported the next
  // trigger is a legitimate retry (the outbox replay/clear flow depends on it).
  void result.then((report) => {
    if (report.report !== null) return;
    const current = recentRuntimeAuthFailureReportsByStableKey.get(dedupeKey);
    if (current?.result === result) {
      recentRuntimeAuthFailureReportsByStableKey.delete(dedupeKey);
    }
  });
  return await result;
}

import { join } from 'node:path';

import {
  createJsonlFollowController,
  type JsonlFollowController,
  type JsonlFollowControllerWatchFile,
} from '@/agent/localControl/jsonlFollowController';
import type { JsonlFollowPolicyInput } from '@/agent/localControl/jsonlFollowPolicy';
import { logger } from '@/ui/logger';

import {
  createClaudeWorkflowJournalWrapper,
  parseClaudeWorkflowFact,
} from './claudeWorkflowCorrelation';

type WorkflowJournalEntry = Readonly<{
  workflowToolUseId: string;
  transcriptDir: string;
  sourceSessionId?: string;
  controller: JsonlFollowController;
}>;

export type ClaudeWorkflowJournalFollower = Readonly<{
  observeTranscriptMessage(message: unknown): void;
  markRunCompleted(runId: string): void;
  syncAll(): Promise<void>;
  dispose(): void;
}>;

export function createClaudeWorkflowJournalFollower(params: Readonly<{
  onJournalValue: (value: unknown) => void;
  watchFile?: JsonlFollowControllerWatchFile | undefined;
  followPolicy?: JsonlFollowPolicyInput | undefined;
  logPrefix?: string | undefined;
}>): ClaudeWorkflowJournalFollower {
  const logPrefix = params.logPrefix ?? '[claude-workflow-journal]';
  const entriesByRunId = new Map<string, WorkflowJournalEntry>();
  const pendingRegistrations = new Set<Promise<void>>();

  function registerJournal(paramsForRun: Readonly<{
    workflowToolUseId: string;
    transcriptDir: string;
    sourceSessionId?: string | undefined;
  }>): void {
    const existing = entriesByRunId.get(paramsForRun.workflowToolUseId);
    if (existing?.transcriptDir === paramsForRun.transcriptDir) return;
    if (existing) {
      void existing.controller.stop();
      entriesByRunId.delete(paramsForRun.workflowToolUseId);
    }

    const journalPath = join(paramsForRun.transcriptDir, 'journal.jsonl');
    const controller = createJsonlFollowController({
      filePath: journalPath,
      ...(params.followPolicy ? { pollPolicy: params.followPolicy } : {}),
      ...(params.watchFile ? { watchFile: params.watchFile } : {}),
      onJson: (entry) => {
        params.onJournalValue(createClaudeWorkflowJournalWrapper({
          workflowToolUseId: paramsForRun.workflowToolUseId,
          entry,
          ...(paramsForRun.sourceSessionId ? { sourceSessionId: paramsForRun.sourceSessionId } : {}),
        }));
      },
      onError: (error) => {
        logger.debug(`${logPrefix}: workflow journal follower error for ${paramsForRun.workflowToolUseId}`, error);
      },
      onClosed: () => {
        const current = entriesByRunId.get(paramsForRun.workflowToolUseId);
        if (current?.controller === controller) entriesByRunId.delete(paramsForRun.workflowToolUseId);
      },
    });

    entriesByRunId.set(paramsForRun.workflowToolUseId, {
      workflowToolUseId: paramsForRun.workflowToolUseId,
      transcriptDir: paramsForRun.transcriptDir,
      ...(paramsForRun.sourceSessionId ? { sourceSessionId: paramsForRun.sourceSessionId } : {}),
      controller,
    });

    const registration = controller.start().catch((error) => {
      logger.debug(`${logPrefix}: workflow journal follower failed to start for ${paramsForRun.workflowToolUseId}`, error);
    });
    pendingRegistrations.add(registration);
    void registration.finally(() => pendingRegistrations.delete(registration));
  }

  return {
    observeTranscriptMessage(message) {
      const fact = parseClaudeWorkflowFact(message);
      if (fact?.kind !== 'workflow-launch' || !fact.transcriptDir) return;
      registerJournal({
        workflowToolUseId: fact.workflowToolUseId,
        transcriptDir: fact.transcriptDir,
        ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      });
    },
    markRunCompleted(runId) {
      entriesByRunId.get(runId)?.controller.markCompleted();
    },
    async syncAll() {
      if (pendingRegistrations.size > 0) {
        await Promise.allSettled([...pendingRegistrations]);
      }
      for (const entry of entriesByRunId.values()) {
        await entry.controller.drainNow();
      }
    },
    dispose() {
      for (const entry of entriesByRunId.values()) {
        void entry.controller.stop();
      }
      entriesByRunId.clear();
      pendingRegistrations.clear();
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import { buildSessionWorkflowActivityHeadline } from '@happier-dev/protocol';

import type { Session } from '../session';
import { createClaudeProviderActivityLedger } from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import {
  ACTIVITY_SYSTEM_RECORD_KINDS,
  ACTIVITY_SYSTEM_RECORD_NAMESPACE,
  sealWorkflowRunSystemRecordPayload,
} from '@/session/systemRecords/activity/activitySystemRecords';
import { createClaudeWorkflowActivitySourceForSession as createProductionClaudeWorkflowActivitySourceForSession } from './createClaudeWorkflowActivitySourceForSession';
function createClaudeWorkflowActivitySourceForSession(
  params: Parameters<typeof createProductionClaudeWorkflowActivitySourceForSession>[0],
) {
  return createProductionClaudeWorkflowActivitySourceForSession(params);
}

function workflowRecord(
  runId: string,
  status: 'active' | 'complete' | 'unknown' | 'blocked' | 'cancelled',
  workflowToolUseId = runId,
) {
  return {
    id: `record-${runId}`,
    sessionId: 'happy-session-id',
    namespace: ACTIVITY_SYSTEM_RECORD_NAMESPACE,
    kind: ACTIVITY_SYSTEM_RECORD_KINDS.workflowRun,
    localId: `activity:workflow_run:v1:${runId}`,
    content: sealWorkflowRunSystemRecordPayload({
      mode: 'plain',
      payload: {
        v: 1,
        projectionVersion: 1,
        runId,
        backendId: 'claude',
        title: runId,
        status,
        workflowToolUseId,
        recordRevision: '1',
        updatedAt: 1_000,
        totalAgents: 1,
        completedAgents: status === 'complete' ? 1 : 0,
        phases: [],
        agents: [],
      },
    }),
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  } as const;
}

function createSessionStub(params?: Readonly<{
  runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter>;
}>): Session {
  return {
    sessionId: 'happy-session-id',
    registerWorkflowTaskOwnershipClassifier: vi.fn(() => () => {}),
    getProviderTaskRuntimeActivityAdapter: vi.fn(() => params?.runtimeActivityAdapter ?? null),
    client: {
      sessionId: 'happy-session-id',
      getMetadataSnapshot: () => ({ claudeSessionId: 'claude-session-id' }),
      updateMetadata: vi.fn(),
      upsertSessionSystemRecord: vi.fn(),
      fetchSessionSystemRecordsPage: vi.fn(async () => ({ records: [], nextCursor: null, hasNext: false })),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    },
  } as unknown as Session;
}

function workflowToolUse(toolUseId: string) {
  return {
    type: 'assistant',
    session_id: 'claude-session-id',
    message: {
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Workflow',
        input: { workflow: 'test-workflow' },
      }],
    },
  };
}

function workflowLaunch(params: Readonly<{
  toolUseId: string;
  taskId: string;
  providerRunId: string;
}>) {
  return {
    type: 'user',
    session_id: 'claude-session-id',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: params.toolUseId,
        content: `Workflow launched in background. Task ID: ${params.taskId}\nRun ID: ${params.providerRunId}`,
      }],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: params.taskId,
      taskType: 'local_workflow',
      runId: params.providerRunId,
    },
  };
}

function successfulWorkflowTaskStop(taskId: string) {
  return {
    type: 'user',
    session_id: 'claude-session-id',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_task_stop',
        content: `Successfully stopped task: ${taskId} (local_workflow)`,
      }],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${taskId} (local_workflow)`,
      task_id: taskId,
      task_type: 'local_workflow',
    },
  };
}

describe('createClaudeWorkflowActivitySourceForSession', () => {
  it('returns null when the session client cannot write system records', async () => {
    const session = createSessionStub();
    delete (session.client as unknown as Record<string, unknown>).upsertSessionSystemRecord;

    const source = await createClaudeWorkflowActivitySourceForSession({
      session,
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => null,
    });

    expect(source).toBeNull();
  });

  it('returns null when the session client cannot expose stored-content encryption context', async () => {
    const session = createSessionStub();
    delete (session.client as unknown as Record<string, unknown>).getStoredContentEncryptionContext;

    const source = await createClaudeWorkflowActivitySourceForSession({
      session,
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => null,
    });

    expect(source).toBeNull();
  });

  it('wires a live source through the session client transport and encryption context', async () => {
    const source = await createClaudeWorkflowActivitySourceForSession({
      session: createSessionStub(),
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => 'claude-session-id',
    });

    expect(source).not.toBeNull();
    // The composed source exposes the CWF surface (observe + CWF4 owned-id hook + lifecycle).
    expect(typeof source?.observeTranscriptMessage).toBe('function');
    expect(source?.getWorkflowOwnedAgentToolUseIds()).toBeInstanceOf(Set);

    source?.dispose();
  });

  it('closes the existing provider Runtime Activity contribution from an exact live workflow terminal', async () => {
    const runtimeActivityReports: Array<Readonly<{ state: string; activeCount: number }>> = [];
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: createClaudeProviderActivityLedger(),
      contributionHandle: {
        report: vi.fn(async (value) => { runtimeActivityReports.push(value); }),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });
    await runtimeActivityAdapter.activateObservation('observer-installed');
    await runtimeActivityAdapter.observeActivity({
      activity: {
        type: 'started',
        sessionId: 'claude-session-id',
        taskId: 'workflow-task-1',
      },
      evidence: 'live',
    });

    const source = await createClaudeWorkflowActivitySourceForSession({
      session: createSessionStub({ runtimeActivityAdapter }),
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => 'claude-session-id',
    });
    source?.observeTranscriptMessage(workflowToolUse('toolu_workflow'));
    source?.observeTranscriptMessage(workflowLaunch({
      toolUseId: 'toolu_workflow',
      taskId: 'workflow-task-1',
      providerRunId: 'workflow-provider-run-1',
    }));
    source?.observeTranscriptMessage(successfulWorkflowTaskStop('workflow-task-1'));
    await source?.flush();

    expect(runtimeActivityReports).toEqual([
      { state: 'idle', activeCount: 0 },
      { state: 'active', activeCount: 1 },
      { state: 'idle', activeCount: 0 },
    ]);
    source?.dispose();
  });

});

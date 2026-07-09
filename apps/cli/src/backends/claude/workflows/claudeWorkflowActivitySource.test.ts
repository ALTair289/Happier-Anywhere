import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SessionWorkflowActivityHeadlineV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import {
  createSessionRuntimeActivityPublisher,
  type RuntimeActivityProjectionWriter,
  type SessionRuntimeActivityPublisher,
} from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';
import { createClaudeWorkflowActivitySource } from './claudeWorkflowActivitySource';

function createRuntimeActivityPublisherHarness() {
  const publisher: Pick<SessionRuntimeActivityPublisher, 'setSourceActive' | 'observeSource' | 'clearSource' | 'clearProviderSources'> = {
    setSourceActive: vi.fn(async () => {}),
    observeSource: vi.fn(async () => {}),
    clearSource: vi.fn(async () => {}),
    clearProviderSources: vi.fn(async () => {}),
  };
  return { publisher };
}

function workflowToolUse(id: string, name: string, sessionId = 'claude-session-1') {
  return {
    type: 'assistant',
    session_id: sessionId,
    uuid: `uuid-${id}`,
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Workflow',
          input: { script: `export const meta = { name: '${name}', phases: [{ title: 'Verify' }] }` },
        },
      ],
    },
  };
}

function workflowLaunchResult(toolUseId: string, transcriptDir: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    sessionId,
    uuid: `uuid-launch-${toolUseId}`,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Workflow launched in background.\nTranscript dir: ${transcriptDir}`,
          is_error: false,
        },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: 'workflow-task-1',
      taskType: 'local_workflow',
      workflowName: 'sidecar-wf',
      runId: 'wf_sidecar',
      transcriptDir,
    },
  };
}

function workflowFailedResult(toolUseId: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    session_id: sessionId,
    uuid: `uuid-failed-${toolUseId}`,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content:
            '<tool_use_error>Invalid workflow script: Script parse error: Unexpected token (226:0).</tool_use_error>',
          is_error: true,
        },
      ],
    },
  };
}

function agentAsyncLaunchResult(toolUseId: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    session_id: sessionId,
    uuid: `uuid-agent-launch-${toolUseId}`,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'text',
              text:
                "Async agent launched successfully.\nagentId: a92c3cece749417e2 (internal ID - do not mention to user.)",
            },
          ],
          is_error: false,
        },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      agentId: 'a92c3cece749417e2',
    },
  };
}

function terminalUpdate(taskId = 'w1', sessionId = 'claude-session-1', status = 'completed') {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status, end_time: 9999 },
    session_id: sessionId,
    uuid: 'uuid-term',
  };
}

function taskStarted(toolUseId: string, taskId = 'w1', sessionId = 'claude-session-1') {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: 'local_workflow',
    description: 'work',
    session_id: sessionId,
    uuid: 'uuid-started',
  };
}

describe('createClaudeWorkflowActivitySource', () => {
  const tempDirs: string[] = [];

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function setup() {
    const committed: string[] = [];
    const headlines: unknown[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (s) => { committed.push(s.runId); },
      writeHeadline: (h) => { headlines.push(h); },
      debounceMs: 300,
    });
    return { committed, headlines, source };
  }

  it('publishes a run record + headline immediately on a Workflow start', async () => {
    const { committed, headlines, source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toContain('toolu_wf');
    expect(headlines).toHaveLength(1);
  });

  it('publishes immediately on a terminal transition', async () => {
    const { committed, source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(taskStarted('toolu_wf'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;
    source.observeTranscriptMessage(terminalUpdate());
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toContain('toolu_wf');
  });

  it('terminalizes a failed Workflow tool result so it leaves active workflow headlines', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: SessionWorkflowActivityHeadlineV1[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadline: (headline) => { headlines.push(headline); },
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_failed_wf', 'failed-wf'));
    await vi.advanceTimersByTimeAsync(0);
    source.observeTranscriptMessage(workflowFailedResult('toolu_failed_wf'));
    await vi.advanceTimersByTimeAsync(0);

    expect(committed.at(-1)).toEqual(expect.objectContaining({
      runId: 'toolu_failed_wf',
      status: 'failed',
      totalAgents: 0,
      completedAgents: 0,
    }));
    expect(headlines.at(-1)?.activeRuns.map((run) => run.runId)).not.toContain('toolu_failed_wf');
    expect(headlines.at(-1)?.recentRuns?.map((run) => run.runId)).toContain('toolu_failed_wf');

    source.dispose();
  });

  it('renews the runtime-activity lease on every durable commit, not only changed observations (W-4)', async () => {
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher: runtimeActivity.publisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    // A progress-only (non-status-changing) update: this commits durably on the debounce, and the
    // lease must be renewed off that commit even though it is not a started/terminal transition.
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'w1',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      session_id: 'claude-session-1',
      usage: { total_tokens: 50 },
      uuid: 'uuid-progress-heartbeat',
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(runtimeActivity.publisher.observeSource).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'claude_workflow_durable_commit' }),
    );

    source.dispose();
  });

  it('reconciles unobserved startup runs to stopped/interrupted through the one-writer path (W-1)', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: SessionWorkflowActivityHeadlineV1[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadline: (headline) => { headlines.push(headline); },
      debounceMs: 300,
    });

    // A run genuinely resumed live since startup must be excluded from reconciliation.
    source.observeTranscriptMessage(workflowToolUse('toolu_resumed', 'resumed'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;
    headlines.length = 0;

    await source.reconcileStartupInterruptedRuns([
      { runId: 'toolu_resumed', title: 'resumed', totalAgents: 1, completedAgents: 0 },
      { runId: 'wf_crashed', title: 'Crashed workflow', workflowToolUseId: 'toolu_crashed', totalAgents: 4, completedAgents: 2 },
    ]);

    expect(committed.map((s) => s.runId)).toEqual(['wf_crashed']);
    expect(committed[0]).toMatchObject({ status: 'stopped', statusReason: 'interrupted', totalAgents: 4, completedAgents: 2 });
    const lastHeadline = headlines.at(-1);
    expect(lastHeadline?.activeRuns.map((r) => r.runId)).not.toContain('wf_crashed');
    expect(lastHeadline?.recentRuns?.find((r) => r.runId === 'wf_crashed')?.statusReason).toBe('interrupted');

    source.dispose();
  });

  it('does not publish workflow records or headlines for async Agent launches', async () => {
    const { committed, headlines, source } = setup();
    source.observeTranscriptMessage(agentAsyncLaunchResult('toolu_agent'));
    await vi.advanceTimersByTimeAsync(0);

    expect(committed).toEqual([]);
    expect(headlines).toEqual([]);

    source.dispose();
  });

  it('publishes and clears canonical runtime activity for workflow lifecycle changes', async () => {
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher: runtimeActivity.publisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'w1',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      session_id: 'claude-session-1',
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'Verify' },
        { type: 'workflow_agent', agentId: 'agent_1', label: 'first', phaseIndex: 1, state: 'running' },
      ],
      uuid: 'uuid-progress',
    });
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'w1',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      session_id: 'claude-session-1',
      usage: { total_tokens: 50 },
      uuid: 'uuid-progress-2',
    });
    source.observeTranscriptMessage(terminalUpdate());

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:toolu_wf',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:toolu_wf',
        'claude_workflow_runtime_source_rekeyed',
      );
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:w1',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
      expect(runtimeActivity.publisher.observeSource).toHaveBeenCalledWith({
        id: 'claude:provider-task:w1',
        reason: 'claude_workflow_activity_changed',
      });
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:w1',
        'claude_workflow_terminal',
      );
    });

    source.dispose();
  });

  it('clears the initial workflow runtime source when the provider task id is only learned at terminal', async () => {
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher: runtimeActivity.publisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(taskStarted('toolu_wf', 'w1'));
    source.observeTranscriptMessage(terminalUpdate('w1'));

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:toolu_wf',
        'claude_workflow_terminal',
      );
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:w1',
        'claude_workflow_terminal',
      );
    });

    source.dispose();
  });

  it('rekeys workflow runtime activity from the real launch result provider task id', async () => {
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-workflow-launch-'));
    tempDirs.push(transcriptDir);
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher: runtimeActivity.publisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(workflowLaunchResult('toolu_wf', transcriptDir));

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:toolu_wf',
        'claude_workflow_runtime_source_rekeyed',
      );
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:workflow-task-1',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
    });

    source.dispose();
  });

  it('recovers workflow runtime projection when the first launch projection write fails', async () => {
    let attempts = 0;
    const writes: Parameters<RuntimeActivityProjectionWriter>[0][] = [];
    const runtimeActivityPublisher = createSessionRuntimeActivityPublisher({
      nowMs: () => 1_000,
      leaseDurationMs: 5_000,
      projectionRetryDelayMs: 250,
      updateRuntimeActivityProjection: async (projection) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('socket temporarily unavailable');
        }
        writes.push(projection);
      },
    });
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-workflow-retry-'));
    tempDirs.push(transcriptDir);
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(workflowLaunchResult('toolu_wf', transcriptDir));

    await vi.advanceTimersByTimeAsync(250);

    await vi.waitFor(() => {
      expect(writes.at(-1)).toEqual({
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 6_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      });
    });

    source.dispose();
  });

  it('clears workflow runtime activity when Agent SDK terminal status aliases arrive', async () => {
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher: runtimeActivity.publisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(taskStarted('toolu_wf', 'w1'));
    source.observeTranscriptMessage(terminalUpdate('w1', 'claude-session-1', 'succeeded'));

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:w1',
        'claude_workflow_terminal',
      );
    });

    source.dispose();
  });

  it('clears active workflow runtime sources during source disposal', async () => {
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadline: () => {},
      runtimeActivityPublisher: runtimeActivity.publisher,
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(taskStarted('toolu_wf', 'w1'));
    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:toolu_wf',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
    });

    source.dispose();

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:toolu_wf',
        'claude_workflow_source_disposed',
      );
    });
  });

  it('ignores non-workflow transcript noise', async () => {
    const { committed, source } = setup();
    source.observeTranscriptMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    await vi.advanceTimersByTimeAsync(300);
    expect(committed).toHaveLength(0);
  });

  it('rejects foreign-session workflow events', async () => {
    const { committed, source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_x', 'wf', 'other-session'));
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toHaveLength(0);
  });

  it('exposes workflow-owned agent ids for the CWF4 work-state filter', async () => {
    const { source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'w1',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      session_id: 'claude-session-1',
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'P' },
        { type: 'workflow_agent', agentId: 'agent_1', label: 'a', phaseIndex: 1, state: 'running' },
      ],
      uuid: 'uuid-prog',
    });
    expect(source.getWorkflowOwnedAgentToolUseIds().has('agent_1')).toBe(true);
  });

  it('flush() drains pending progress writes', async () => {
    const committed: string[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (s) => { committed.push(s.runId); },
      writeHeadline: () => {},
      debounceMs: 5000,
    });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;
    // A progress-only update is debounced; flush forces it out.
    source.observeTranscriptMessage(taskStarted('toolu_wf'));
    source.observeTranscriptMessage({
      type: 'system', subtype: 'task_progress', task_id: 'w1', tool_use_id: 'toolu_wf',
      task_type: 'local_workflow', session_id: 'claude-session-1',
      usage: { total_tokens: 50 }, uuid: 'p2',
    });
    await source.flush();
    expect(committed).toContain('toolu_wf');
  });

  it('hydrates unified Workflow launch results from the sidecar journal', async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-workflow-sidecar-'));
    tempDirs.push(transcriptDir);
    await writeFile(join(transcriptDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'lane-1', agentId: 'agent_alpha' }),
      JSON.stringify({ type: 'started', key: 'lane-2', agentId: 'agent_beta' }),
      JSON.stringify({
        type: 'result',
        key: 'lane-1',
        agentId: 'agent_alpha',
        result: { lane: 'alpha-review', verdict: 'plan_correct', summary: 'Alpha lane finished.' },
      }),
    ].join('\n') + '\n');

    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadline: () => {},
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'sidecar-wf'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;

    source.observeTranscriptMessage(workflowLaunchResult('toolu_wf', transcriptDir));
    await source.flush();

    const snapshot = committed.at(-1);
    expect(snapshot?.runId).toBe('toolu_wf');
    expect(snapshot?.phases.map((phase) => phase.title)).toEqual(['Verify']);
    expect(snapshot?.phases[0]?.agentIds).toEqual(['agent_alpha', 'agent_beta']);
    expect(snapshot?.totalAgents).toBe(2);
    expect(snapshot?.completedAgents).toBe(1);
    expect(snapshot?.agents.map((agent) => ({ id: agent.id, title: agent.title, status: agent.status }))).toEqual([
      { id: 'agent_alpha', title: 'alpha-review', status: 'complete' },
      { id: 'agent_beta', title: 'Workflow agent 2', status: 'active' },
    ]);
    expect(snapshot?.agents[0]?.resultPreview).toContain('Alpha lane finished.');

    source.dispose();
  });
});

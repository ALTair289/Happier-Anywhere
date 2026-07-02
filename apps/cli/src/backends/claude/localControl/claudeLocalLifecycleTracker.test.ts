import { describe, expect, it, vi } from 'vitest';

import { createLocalTurnLifecycleController, type LocalTurnLifecycleSnapshot } from '@/agent/localControl/turnLifecycle';
import { STANDARD_CONTINUATION_RESUME_PROMPT } from '@/daemon/connectedServices/continuation/continuationResumePrompt';
import type { SessionRuntimeActivityPublisher } from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';
import type { RawJSONLines } from '../types';
import { createClaudeLocalLifecycleTracker } from './claudeLocalLifecycleTracker';

function createRuntimeActivityPublisherHarness() {
  const publisher: SessionRuntimeActivityPublisher = {
    setSourceActive: vi.fn(async () => {}),
    observeSource: vi.fn(async () => {}),
    observeAmbientLiveness: vi.fn(async () => {}),
    clearSource: vi.fn(async () => {}),
    clearProviderSources: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
    reconcileSources: vi.fn(async () => {}),
    getProjection: vi.fn(() => ({
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: null,
    })),
    getSnapshot: vi.fn(() => ({
      v: 1 as const,
      observedAtMs: 0,
      activeCount: 0,
      sources: [],
    })),
  };
  return { publisher };
}

describe('createClaudeLocalLifecycleTracker', () => {
  it('translates lifecycle hooks and transcript continuation into safe handoff timing', async () => {
    vi.useFakeTimers();
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 500 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const waiting = lifecycle.waitForSafeRemoteHandoff();

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', stop_hook_active: false });
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observeTranscript({
      type: 'user',
      uuid: 'feedback',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Stop hook feedback:\nContinue.' }] },
    } as any);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', stop_hook_active: true });
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toMatchObject({ lastTerminalReason: 'completed' });
    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('does not convert a meta continuation no-op transcript pair into a completed provider turn', () => {
    const observed: LocalTurnLifecycleSnapshot[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (snapshot) => {
        observed.push(snapshot);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'meta-continuation-prompt',
      isMeta: true,
      message: {
        role: 'user',
        content: STANDARD_CONTINUATION_RESUME_PROMPT,
      },
    } satisfies RawJSONLines);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'synthetic-no-response',
      model: '<synthetic>',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    } satisfies RawJSONLines);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: false,
      waitingForQuiescence: false,
    });
    expect(observed).toEqual([]);
    lifecycle.dispose();
  });

  it('treats StopFailure, transcript interruption, SessionEnd, and process exit as terminal boundaries', async () => {
    const failure = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const failureTracker = createClaudeLocalLifecycleTracker({ lifecycle: failure });
    failureTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const failureWait = failure.waitForSafeRemoteHandoff();
    failureTracker.observeHook({ session_id: 'sid', hook_event_name: 'StopFailure' });
    await expect(failureWait).resolves.toMatchObject({ lastTerminalReason: 'failed' });
    failure.dispose();

    const interrupted = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const interruptedTracker = createClaudeLocalLifecycleTracker({ lifecycle: interrupted });
    interruptedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const interruptedWait = interrupted.waitForSafeRemoteHandoff();
    interruptedTracker.observeTranscript({
      type: 'user',
      uuid: 'interrupt',
      message: { content: '[Request interrupted by user]' },
    } as any);
    await expect(interruptedWait).resolves.toMatchObject({ lastTerminalReason: 'aborted' });
    interrupted.dispose();

    const ended = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const endedTracker = createClaudeLocalLifecycleTracker({ lifecycle: ended });
    endedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const endedWait = ended.waitForSafeRemoteHandoff();
    endedTracker.observeHook({ session_id: 'sid', hook_event_name: 'SessionEnd', reason: 'other' });
    await expect(endedWait).resolves.toMatchObject({ lastTerminalReason: 'session-ended' });
    ended.dispose();

    const exited = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const exitedTracker = createClaudeLocalLifecycleTracker({ lifecycle: exited });
    exitedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const exitedWait = exited.waitForSafeRemoteHandoff();
    exitedTracker.observeProcessExit();
    await expect(exitedWait).resolves.toMatchObject({ lastTerminalReason: 'process-exited' });
    exited.dispose();
  });

  it('preserves official and legacy StopFailure error discriminators on terminal lifecycle events', async () => {
    const observedDetails: Array<string | undefined> = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        if (event.type === 'turn_terminal') observedDetails.push(event.detail);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_type: 'legacy_should_not_win',
    } as any);
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      error_type: 'rate_limit',
    } as any);

    expect(observedDetails).toEqual(['rate_limit', 'rate_limit']);
    lifecycle.dispose();
  });

  it('completes the foreground turn while async Agent background tasks are still running', async () => {
    const observedSnapshots: LocalTurnLifecycleSnapshot[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (snapshot) => {
        observedSnapshots.push(snapshot);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-2',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_2' },
    } as any);

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'yielded-while-agents-run',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agents are running.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-1-completed',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-2-completed',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>agent_2</task-id><status>completed</status></task-notification>' },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    expect(observedSnapshots.some((snapshot) => snapshot.terminal && snapshot.lastTerminalReason === 'completed')).toBe(true);
    lifecycle.dispose();
  });

  it('does not suppress a foreground completion candidate solely because detached provider tasks remain active', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('clears detached task notification activity without emitting a continuation turn', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-completed',
      origin: { kind: 'task-notification', taskId: 'agent_1', status: 'completed' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);

    expect(observedEvents).not.toContain('continuation_detected:claude_transcript_task_notification');
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('does not reopen a completed foreground turn for detached task notifications or generic lifecycle presence', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'late-agent-completed',
      origin: { kind: 'task-notification', taskId: 'agent_1', status: 'completed' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'SessionStart' });
    tracker.observeProcessExit();

    expect(observedEvents).not.toContain('continuation_detected:claude_transcript_task_notification');
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('does not treat a hook-originated task notification as a new foreground prompt', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    observedEvents.length = 0;

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'UserPromptSubmit',
      prompt: [
        '<task-notification>',
        '<task-id>agent_1</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        '<status>completed</status>',
        '</task-notification>',
      ].join('\n'),
    });

    expect(observedEvents).toEqual([]);
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('publishes detached transcript activity and clears it without reopening the foreground lifecycle', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-progress',
      origin: { kind: 'task-notification', taskId: 'agent_1', status: 'running' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>running</status></task-notification>' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-completed',
      origin: { kind: 'task-notification', taskId: 'agent_1', status: 'completed' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:agent_1',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:agent_1',
        'claude_provider_task_terminal',
      );
    });
    expect(runtimeActivity.publisher.observeAmbientLiveness).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('publishes Bash background command runtime activity from bare backgroundTaskId tool results', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'bash-background-launch',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_bash',
          content:
            'Command running in background with ID: b9c3fz9oq. Output is being written to: /tmp/b9c3fz9oq.output.',
          is_error: false,
        }],
      },
      toolUseResult: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        backgroundTaskId: 'b9c3fz9oq',
      },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:b9c3fz9oq',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
    });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('publishes detached transcript activity when the first evidence is a non-terminal task notification', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-progress-first',
      origin: { kind: 'task-notification', taskId: 'agent_progress_first', status: 'running' },
      message: {
        content: '<task-notification><task-id>agent_progress_first</task-id><status>running</status></task-notification>',
      },
    } as any);

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:agent_progress_first',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
    });
    expect(runtimeActivity.publisher.observeSource).not.toHaveBeenCalledWith({
      id: 'claude:provider-task:agent_progress_first',
      reason: 'claude_provider_task_progress',
    });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('clears Claude runtime activity on process exit and Stop hook no-background evidence', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    tracker.observeProcessExit();

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.clearProviderSources).toHaveBeenCalledWith(
        'claude',
        'claude_hook_no_background_tasks',
      );
      expect(runtimeActivity.publisher.clearProviderSources).toHaveBeenCalledWith(
        'claude',
        'claude_process_exit',
      );
    });
    lifecycle.dispose();
  });

  it('reconciles named Stop hook background tasks without renewing surviving sources', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-2',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_2' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [{ task_id: 'agent_2' }],
    });

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.clearSource).toHaveBeenCalledWith(
        'claude:provider-task:agent_1',
        'claude_hook_background_tasks_reconciled',
      );
    });
    expect(runtimeActivity.publisher.clearSource).not.toHaveBeenCalledWith(
      'claude:provider-task:agent_2',
      expect.any(String),
    );
    expect(runtimeActivity.publisher.observeSource).not.toHaveBeenCalled();
    expect(runtimeActivity.publisher.clearProviderSources).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it('publishes workflow background tasks reported by Stop hooks without keeping the foreground turn open', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [
        {
          id: 'workflow_1',
          type: 'workflow',
          status: 'running',
          name: 'long-running-workflow',
        },
      ],
    });

    await vi.waitFor(() => {
      expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:workflow_1',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
    });
    expect(runtimeActivity.publisher.observeSource).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('keeps an active Claude turn running across provider auto compact boundaries', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'system',
      uuid: 'auto-compact-boundary',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto' },
      session_id: 'sid-after-compact',
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
      waitingForQuiescence: false,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'tool-result-after-auto-compact',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
    });

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'summary-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done after compact.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('ignores sidechain-attributed hooks for the primary turn lifecycle', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    // A subagent prompt does not start a primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'UserPromptSubmit',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: false, terminal: false });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // Live incident 2026-06-12 (session cmq8171…): subagent auth StopFailures must not
    // fail the primary turn while the main agent keeps working.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
      error: 'authentication_failed',
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // A subagent Stop does not complete the primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      agent_id: 'agent_sidechain_1',
      background_tasks: [],
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // A subagent SessionEnd does not end the primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'SessionEnd',
      agent_id: 'agent_sidechain_1',
      reason: 'other',
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // Main-agent terminal evidence still terminalizes (control).
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'StopFailure' });
    expect(lifecycle.snapshot()).toMatchObject({ terminal: true, lastTerminalReason: 'failed' });
    lifecycle.dispose();
  });

  it('ignores sidechain-attributed hooks because runtime activity is owned by the session hook boundary', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_sidechain_1' },
    } as any);
    vi.mocked(runtimeActivity.publisher.setSourceActive).mockClear();

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'PostToolUse',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
      tool_name: 'Bash',
    } as any);

    await Promise.resolve();
    expect(runtimeActivity.publisher.setSourceActive).not.toHaveBeenCalled();
    expect(runtimeActivity.publisher.observeSource).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({ active: false, terminal: false });
    lifecycle.dispose();
  });

  it('ignores sidechain Stop while detached provider activity remains separate from foreground completion', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      agent_id: 'agent_sidechain_1',
      background_tasks: [],
    });

    // The sidechain Stop is ignored, and the detached agent ledger must not
    // suppress the foreground completion once the primary assistant result lands.
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'yielded-while-agents-run',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agent is running.' }] },
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [],
    });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('treats Stop with no background tasks as completion after async Agent launches', async () => {
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [],
    });

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });
});

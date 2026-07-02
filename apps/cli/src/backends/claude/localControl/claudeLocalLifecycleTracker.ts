import type {
  LocalTurnLifecycleController,
  LocalTurnLifecycleEvent,
} from '@/agent/localControl/turnLifecycle';
import type { RawJSONLines } from '@/backends/claude/types';
import type { SessionHookData } from '../utils/startHookServer';
import {
  isSidechainSessionHook,
  readSessionHookEventName,
} from '../utils/sessionHookAttribution';
import { readClaudeSessionHookBackgroundTasks } from '../utils/sessionHookBackgroundTasks';
export { isClaudeTaskNotificationUserPromptHook } from '../utils/sessionHookTaskNotification';
import { isClaudeTaskNotificationUserPromptHook } from '../utils/sessionHookTaskNotification';
import {
  buildClaudeProviderTaskRuntimeActivitySourceId,
  CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
  CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
  createClaudeProviderActivityLedger,
  type ClaudeProviderRuntimeActivityPublisher,
} from '../providerActivity/createClaudeProviderActivityLedger';
import { readClaudeTranscriptProviderActivity } from './readClaudeTranscriptProviderActivity';
import { readClaudeTranscriptTurnSignal } from './readClaudeTranscriptTurnSignal';

function readHookErrorDiscriminator(data: SessionHookData): string | undefined {
  const raw = data.error ?? data.error_type;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function hookToLifecycleEvent(data: SessionHookData): LocalTurnLifecycleEvent | null {
  const hookEventName = readSessionHookEventName(data);
  if (hookEventName === 'UserPromptSubmit') {
    if (isClaudeTaskNotificationUserPromptHook(data)) return null;
    return { type: 'turn_started', providerTurnId: null, source: 'claude_hook_user_prompt_submit' };
  }
  if (hookEventName === 'Stop') {
    return { type: 'completion_candidate', providerTurnId: null, source: 'claude_hook_stop' };
  }
  if (hookEventName === 'StopFailure') {
    return {
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'failed',
      source: 'claude_hook_stop_failure',
      detail: readHookErrorDiscriminator(data),
    };
  }
  if (hookEventName === 'SessionEnd') {
    return { type: 'session_ended', source: 'claude_hook_session_end' };
  }
  return null;
}

export function createClaudeLocalLifecycleTracker(opts: Readonly<{
  lifecycle: LocalTurnLifecycleController;
  runtimeActivityPublisher?: ClaudeProviderRuntimeActivityPublisher | null;
}>) {
  const providerActivityLedger = createClaudeProviderActivityLedger();

  const runRuntimeActivityEffect = (
    _label: string,
    effect: () => Promise<void> | void,
  ): void => {
    try {
      void Promise.resolve(effect()).catch(() => undefined);
    } catch {
      // Runtime-activity projection is non-critical to local lifecycle parsing.
    }
  };

  const setProviderTaskRuntimeActivityActive = (taskId: unknown): void => {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(taskId);
    if (!sourceId || !opts.runtimeActivityPublisher) return;
    runRuntimeActivityEffect('set-active', () => opts.runtimeActivityPublisher?.setSourceActive({
      id: sourceId,
      sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
      providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
    }));
  };

  const clearProviderTaskRuntimeActivity = (
    taskId: unknown,
    reason = 'claude_provider_task_terminal',
  ): void => {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(taskId);
    if (!sourceId || !opts.runtimeActivityPublisher) return;
    runRuntimeActivityEffect('clear-source', () => opts.runtimeActivityPublisher?.clearSource(
      sourceId,
      reason,
    ));
  };

  const observeProviderTaskRuntimeActivity = (taskId: unknown): void => {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(taskId);
    if (!sourceId || !opts.runtimeActivityPublisher) return;
    runRuntimeActivityEffect('observe-source', () => opts.runtimeActivityPublisher?.setSourceActive({
      id: sourceId,
      sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
      providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
    }));
  };

  const renewProviderTaskRuntimeActivity = (taskId: unknown, reason: string): void => {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(taskId);
    if (!sourceId || !opts.runtimeActivityPublisher) return;
    runRuntimeActivityEffect('observe-source', () => opts.runtimeActivityPublisher?.observeSource({
      id: sourceId,
      reason,
    }));
  };

  const clearClaudeRuntimeActivity = (reason: string): void => {
    providerActivityLedger.clearProviderTasks();
    if (!opts.runtimeActivityPublisher) return;
    runRuntimeActivityEffect('clear-provider', () => opts.runtimeActivityPublisher?.clearProviderSources(
      CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
      reason,
    ));
  };

  const reconcileHookBackgroundTasks = (data: SessionHookData): void => {
    const backgroundTasks = readClaudeSessionHookBackgroundTasks(data);
    if (!backgroundTasks) return;
    if (backgroundTasks.activeTaskIds.size === 0 && backgroundTasks.reportsEmpty) {
      clearClaudeRuntimeActivity('claude_hook_no_background_tasks');
      return;
    }
    const knownActiveTaskIds = new Set<string>();
    for (const taskId of backgroundTasks.terminalTaskIds) {
      providerActivityLedger.noteProviderTaskFinished(taskId);
      clearProviderTaskRuntimeActivity(taskId, 'claude_hook_background_task_terminal');
    }
    for (const blocker of providerActivityLedger.getActiveProviderTaskBlockers()) {
      knownActiveTaskIds.add(blocker.taskId);
      if (backgroundTasks.activeTaskIds.has(blocker.taskId)) continue;
      providerActivityLedger.noteProviderTaskFinished(blocker.taskId);
      clearProviderTaskRuntimeActivity(blocker.taskId, 'claude_hook_background_tasks_reconciled');
    }
    for (const taskId of backgroundTasks.activeTaskIds) {
      if (knownActiveTaskIds.has(taskId)) continue;
      providerActivityLedger.noteProviderTaskStarted(taskId);
      setProviderTaskRuntimeActivityActive(taskId);
    }
  };

  const observeLifecycle = (event: LocalTurnLifecycleEvent | null): void => {
    if (!event) return;
    opts.lifecycle.observe(event);
  };

  const observeProviderActivity = (message: RawJSONLines): void => {
    const activity = readClaudeTranscriptProviderActivity(message);
    if (!activity) return;
    if (activity.type === 'async_agent_started') {
      providerActivityLedger.noteTranscriptAsyncAgentTask(activity.taskId);
      setProviderTaskRuntimeActivityActive(activity.taskId);
      return;
    }
    if (activity.type === 'task_notification' && activity.taskId) {
      if (!activity.terminal) {
        observeProviderTaskRuntimeActivity(activity.taskId);
        return;
      }
      providerActivityLedger.noteProviderTaskFinished(activity.taskId);
      clearProviderTaskRuntimeActivity(activity.taskId);
    }
  };

  const observe = (event: LocalTurnLifecycleEvent | null): void => {
    observeLifecycle(event);
  };

  return {
    observeHook(data: SessionHookData): void {
      // Sidechain (subagent) hooks never drive the primary turn lifecycle: a
      // subagent StopFailure/Stop/SessionEnd is not primary-turn evidence.
      // Source-keyed sidechain activity is published at the Claude Session hook
      // boundary so all modes share one runtime-activity producer.
      if (isSidechainSessionHook(data)) {
        return;
      }
      if (readSessionHookEventName(data) === 'Stop') {
        reconcileHookBackgroundTasks(data);
      }
      observe(hookToLifecycleEvent(data));
    },
    observeTranscript(message: RawJSONLines): void {
      observeProviderActivity(message);
      observe(readClaudeTranscriptTurnSignal(message));
    },
    observeProcessExit(): void {
      clearClaudeRuntimeActivity('claude_process_exit');
      const snapshot = opts.lifecycle.snapshot();
      if (!snapshot.active || snapshot.terminal) return;
      opts.lifecycle.observe({
        type: 'turn_terminal',
        providerTurnId: snapshot.providerTurnId,
        reason: 'process-exited',
        source: 'claude_local_process_exit',
      });
    },
  };
}

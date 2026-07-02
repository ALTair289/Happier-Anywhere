import { describe, expect, it, vi } from 'vitest';

import type { SessionRuntimeActivityPublisher } from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';
import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedHookLifecycleBridge } from './createClaudeUnifiedHookLifecycleBridge';

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

describe('createClaudeUnifiedHookLifecycleBridge', () => {
  it('reconciles a provider-accepted prompt on UserPromptSubmit', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const confirmPromptAcceptedByProvider = vi.fn().mockResolvedValue(true);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(confirmPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
      });
    } finally {
      bridge.dispose();
    }
  });

  it('notifies provider prompt start before acceptance reconciliation on UserPromptSubmit', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const calls: string[] = [];
    const onProviderPromptStarted = vi.fn(() => {
      calls.push('provider_prompt_started');
    });
    const confirmPromptAcceptedByProvider = vi.fn(async () => {
      calls.push('accepted');
      return true;
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onProviderPromptStarted,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });

      expect(onProviderPromptStarted).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(confirmPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
      });
      expect(calls).toEqual(['provider_prompt_started', 'accepted']);
    } finally {
      bridge.dispose();
    }
  });

  it('does not treat a hook-originated task notification as provider prompt start evidence', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const confirmPromptAcceptedByProvider = vi.fn().mockResolvedValue(true);
    const onProviderPromptStarted = vi.fn();
    const onTrustedProviderProgress = vi.fn();
    const onThinkingChange = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onProviderPromptStarted,
      onTrustedProviderProgress,
      onThinkingChange,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: [
          '<task-notification>',
          '<task-id>agent_1</task-id>',
          '<tool-use-id>toolu_1</tool-use-id>',
          '<status>completed</status>',
          '</task-notification>',
        ].join('\n'),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onProviderPromptStarted).not.toHaveBeenCalled();
      expect(onTrustedProviderProgress).not.toHaveBeenCalled();
      expect(confirmPromptAcceptedByProvider).not.toHaveBeenCalled();
      expect(onThinkingChange).not.toHaveBeenCalledWith(true);
      expect(observeLifecycle).not.toHaveBeenCalledWith({ type: 'turn_state', state: 'running' });
    } finally {
      bridge.dispose();
    }
  });

  it('waits for async provider prompt start before completing a terminal-originated turn', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let resolveProviderStarted: (() => void) | undefined;
    const onProviderPromptStarted = vi.fn(() => new Promise<void>((resolve) => {
      resolveProviderStarted = resolve;
    }));
    const onReady = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onProviderPromptStarted,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(onProviderPromptStarted).toHaveBeenCalledTimes(1);
      });

      hook({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        background_tasks: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onReady).not.toHaveBeenCalled();
      resolveProviderStarted?.();
      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
    } finally {
      bridge.dispose();
    }
  });

  it('blocks input injection while Claude is waiting on a permission request and redrains after completion', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'PermissionRequest', session_id: 'claude-session-id', tool_use_id: 'toolu_1' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: true });

      hook({ hook_event_name: 'PostToolUse', session_id: 'claude-session-id', tool_use_id: 'toolu_1' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: false });
      await vi.waitFor(() => {
        expect(drainWhenSafe).toHaveBeenCalled();
      });
    } finally {
      bridge.dispose();
    }
  });

  it('does not treat SessionStart alone as trusted prompt progress', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onTrustedProviderProgress = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onTrustedProviderProgress,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'SessionStart', session_id: 'claude-session-id' });
      expect(onTrustedProviderProgress).not.toHaveBeenCalled();

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      expect(onTrustedProviderProgress).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });

  it('keeps input injection blocked until all correlated permission requests complete', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'PermissionRequest', session_id: 'claude-session-id', tool_use_id: 'toolu_1' });
      hook({ hook_event_name: 'PermissionRequest', session_id: 'claude-session-id', tool_use_id: 'toolu_2' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: true });

      hook({ hook_event_name: 'PostToolUse', session_id: 'claude-session-id', tool_use_id: 'toolu_1' });
      expect(observeLifecycle).not.toHaveBeenCalledWith({ type: 'permission', blocked: false });
      expect(drainWhenSafe).not.toHaveBeenCalled();

      hook({ hook_event_name: 'PermissionRequestCompleted', session_id: 'claude-session-id', tool_use_id: 'toolu_2' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: false });
      await vi.waitFor(() => {
        expect(drainWhenSafe).toHaveBeenCalled();
      });
    } finally {
      bridge.dispose();
    }
  });

  it('forwards Claude compaction hooks to the input arbiter lifecycle', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'PreCompact', session_id: 'claude-session-id' });
      hook({ hook_event_name: 'PostCompact', session_id: 'claude-session-id' });

      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'compaction', phase: 'started' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'compaction', phase: 'completed' });
    } finally {
      bridge.dispose();
    }
  });

  it('forwards Claude compact boundary transcript rows as compaction completion', async () => {
    const observeLifecycle = vi.fn();
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: () => null,
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.observeTranscript({
        type: 'system',
        uuid: 'compact-boundary-1',
        subtype: 'compact_boundary',
        session_id: 'claude-session-id',
      } as any);

      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'compaction', phase: 'completed' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'output' });
      expect(drainWhenSafe).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });

  it('waits for async ready completion before redraining after a completed turn', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let resolveReady: (() => void) | undefined;
    const observeLifecycle = vi.fn();
    const onReady = vi.fn(() => new Promise<void>((resolve) => {
      resolveReady = resolve;
    }));
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(true),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(onReady).not.toHaveBeenCalled();
      });

      hook({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        background_tasks: [],
      });

      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
      expect(observeLifecycle).not.toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      expect(drainWhenSafe).not.toHaveBeenCalled();
      resolveReady?.();
      await vi.waitFor(() => {
        expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      });
      await vi.waitFor(() => {
        expect(drainWhenSafe).toHaveBeenCalledTimes(1);
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces hook-only StopFailure rate-limit details', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onUsageLimitDetails = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onUsageLimitDetails,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
        error: 'rate_limit',
        error_type: 'legacy_should_not_win',
      } as any);

      await vi.waitFor(() => {
        expect(onUsageLimitDetails).toHaveBeenCalledWith(expect.objectContaining({
          v: 1,
          providerLimitId: 'rate_limit',
          recoverability: 'wait',
        }));
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces hook-only StopFailure overloaded details from the last assistant message', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onUsageLimitDetails = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onUsageLimitDetails,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
        error: 'server_error',
        last_assistant_message: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      } as any);

      await vi.waitFor(() => {
        expect(onUsageLimitDetails).toHaveBeenCalledWith(expect.objectContaining({
          v: 1,
          limitCategory: 'capacity',
          providerLimitId: 'server_overloaded',
          recoverability: 'wait',
        }));
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces transcript-only Claude auth API errors and marks the turn failed', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const onRuntimeAuthFailureEvent = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onRuntimeAuthFailureEvent,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'assistant-auth-failure',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      } as any);

      await vi.waitFor(() => {
        expect(onRuntimeAuthFailureEvent).toHaveBeenCalledWith(expect.objectContaining({
          error: 'authentication_failed',
        }));
      });
      await vi.waitFor(() => {
        expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      });
    } finally {
      bridge.dispose();
    }
  });

  it('runs the terminal prompt-failure projection before clearing the thinking state', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const order: string[] = [];
    const onThinkingChange = vi.fn((thinking: boolean) => {
      order.push(`thinking:${thinking}`);
    });
    const onPromptTurnTerminal = vi.fn(() => {
      order.push('prompt_turn_terminal');
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onThinkingChange,
      onPromptTurnTerminal,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'assistant-provider-error-ordering',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
        },
      } as any);

      await vi.waitFor(() => {
        expect(onPromptTurnTerminal).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(onThinkingChange).toHaveBeenCalledWith(false);
      });
      // A failed terminal turn must terminalize before the thinking state is
      // cleared; otherwise onThinkingChange(false) emits task_complete first and
      // the failed turn is recorded as completed.
      expect(order.indexOf('prompt_turn_terminal')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('prompt_turn_terminal')).toBeLessThan(order.indexOf('thinking:false'));
    } finally {
      bridge.dispose();
    }
  });

  it('passes the pending provider-acceptance terminal-failure observation result to failed terminal projection', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observePendingProviderAcceptanceTerminalFailure = vi.fn().mockResolvedValue(false);
    const onPromptTurnTerminal = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        observePendingProviderAcceptanceTerminalFailure,
      },
      completionQuiescenceMs: 0,
      onPromptTurnTerminal,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      hook({ hook_event_name: 'StopFailure', session_id: 'claude-session-id' });

      await vi.waitFor(() => {
        expect(onPromptTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
          reason: 'failed',
          source: 'claude_hook_stop_failure',
          providerAcceptanceFailureObserved: false,
        }));
      });
      expect(observePendingProviderAcceptanceTerminalFailure).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });

  it('ignores sidechain-attributed terminal hooks so a subagent StopFailure cannot terminalize the turn', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onThinkingChange = vi.fn();
    const onPromptTurnTerminal = vi.fn();
    const onSessionEnd = vi.fn();
    const onReady = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onThinkingChange,
      onPromptTurnTerminal,
      onSessionEnd,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(onThinkingChange).toHaveBeenCalledWith(true);
      });

      // Live incident 2026-06-12 (session cmq8171…): five subagent auth StopFailures
      // marked the primary turn failed while the main agent kept working.
      hook({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
        agent_id: 'agent_sidechain_1',
        agent_type: 'general-purpose',
        error: 'authentication_failed',
      } as any);
      hook({
        hook_event_name: 'SessionEnd',
        session_id: 'claude-session-id',
        agent_id: 'agent_sidechain_1',
        reason: 'other',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onPromptTurnTerminal).not.toHaveBeenCalled();
      expect(onSessionEnd).not.toHaveBeenCalled();
      expect(onThinkingChange).not.toHaveBeenCalledWith(false);

      // The main-agent Stop still completes the turn normally afterwards.
      hook({ hook_event_name: 'Stop', session_id: 'claude-session-id', background_tasks: [] });
      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
      expect(onPromptTurnTerminal).not.toHaveBeenCalled();
    } finally {
      bridge.dispose();
    }
  });

  it('does not release main-agent permission blocks on sidechain terminal hooks', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'PermissionRequest', session_id: 'claude-session-id', tool_use_id: 'toolu_main' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: true });

      hook({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
        agent_id: 'agent_sidechain_1',
        error: 'authentication_failed',
      } as any);
      expect(observeLifecycle).not.toHaveBeenCalledWith({ type: 'permission', blocked: false });

      hook({ hook_event_name: 'PostToolUse', session_id: 'claude-session-id', tool_use_id: 'toolu_main' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: false });
    } finally {
      bridge.dispose();
    }
  });

  it('ignores sidechain UserPromptSubmit for prompt acceptance, prompt start, and config metadata', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const confirmPromptAcceptedByProvider = vi.fn().mockResolvedValue(true);
    const onProviderPromptStarted = vi.fn();
    const onTrustedProviderProgress = vi.fn();
    const onProviderPromptSubmitMetadata = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onProviderPromptStarted,
      onTrustedProviderProgress,
      onProviderPromptSubmitMetadata,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        agent_id: 'agent_sidechain_1',
        permission_mode: 'auto',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(confirmPromptAcceptedByProvider).not.toHaveBeenCalled();
      expect(onProviderPromptStarted).not.toHaveBeenCalled();
      expect(onTrustedProviderProgress).not.toHaveBeenCalled();
      expect(onProviderPromptSubmitMetadata).not.toHaveBeenCalled();
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces transcript-only provider API errors as terminal prompt failures', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const onPromptTurnTerminal = vi.fn();
    const onUsageLimitDetails = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onPromptTurnTerminal,
      onUsageLimitDetails,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'assistant-provider-error',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
        },
      } as any);

      await vi.waitFor(() => {
        expect(onPromptTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
          reason: 'failed',
          source: 'claude_transcript_api_error',
          detail: 'api_error',
        }));
      });
      await vi.waitFor(() => {
        expect(onUsageLimitDetails).toHaveBeenCalledWith(expect.objectContaining({
          limitCategory: 'capacity',
          providerLimitId: 'server_overloaded',
        }));
      });
      await vi.waitFor(() => {
        expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      });
    } finally {
      bridge.dispose();
    }
  });

  it('fires foreground ready from completion candidate even when detached provider tasks remain active', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onThinkingChange = vi.fn();
    const onReady = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(true),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onThinkingChange,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'user',
        uuid: 'launch-detached-agent',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
        },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
      } as any);
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'foreground-answer-complete',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
      } as any);

      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
      expect(onThinkingChange).toHaveBeenCalledWith(false);
    } finally {
      bridge.dispose();
    }
  });

  it('does not reopen thinking or parent ready for detached task notifications after foreground completion', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onThinkingChange = vi.fn();
    const onReady = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(true),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onThinkingChange,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      hook({ hook_event_name: 'Stop', session_id: 'claude-session-id', background_tasks: [] });

      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
      onThinkingChange.mockClear();
      onReady.mockClear();

      bridge.observeTranscript({
        type: 'user',
        uuid: 'late-agent-completed',
        origin: { kind: 'task-notification', taskId: 'agent_1', status: 'completed' },
        message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
      } as any);
      hook({ hook_event_name: 'SessionStart', session_id: 'claude-session-id' });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onThinkingChange).not.toHaveBeenCalledWith(true);
      expect(onReady).not.toHaveBeenCalled();
    } finally {
      bridge.dispose();
    }
  });

  it('routes detached transcript activity to the runtime activity publisher without foreground lifecycle renewal', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const onThinkingChange = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(true),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onThinkingChange,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'user',
        uuid: 'launch-detached-agent',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
        },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
      } as any);
      hook({ hook_event_name: 'Stop', session_id: 'claude-session-id' });
      onThinkingChange.mockClear();

      bridge.observeTranscript({
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
      expect(onThinkingChange).not.toHaveBeenCalledWith(true);
    } finally {
      bridge.dispose();
      await vi.waitFor(() => {
        expect(runtimeActivity.publisher.clearProviderSources).toHaveBeenCalledWith(
          'claude',
          'claude_unified_bridge_dispose',
        );
      });
    }
  });

  it('does not reopen foreground thinking for late Stop hooks that only report background activity', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onThinkingChange = vi.fn();
    const onReady = vi.fn();
    const runtimeActivity = createRuntimeActivityPublisherHarness();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onThinkingChange,
      onReady,
      runtimeActivityPublisher: runtimeActivity.publisher,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'foreground-result',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Background task launched.' }] },
      } as any);

      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
      expect(onThinkingChange).toHaveBeenCalledWith(false);
      onThinkingChange.mockClear();

      hook({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        background_tasks: [{ id: 'agent-1', type: 'shell', status: 'running' }],
      });

      await vi.waitFor(() => {
        expect(runtimeActivity.publisher.setSourceActive).toHaveBeenCalledWith({
          id: 'claude:provider-task:agent-1',
          sourceClass: 'provider_detached_task',
          providerId: 'claude',
        });
      });
      expect(onThinkingChange).not.toHaveBeenCalledWith(true);
      expect(onThinkingChange).not.toHaveBeenCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });
});

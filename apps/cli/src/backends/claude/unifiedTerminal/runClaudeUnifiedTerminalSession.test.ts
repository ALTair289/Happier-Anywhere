import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionTerminalComposerClearRequestV1,
  SessionTerminalComposerClearResultV1,
} from '@happier-dev/protocol';

import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import type { SessionHookData } from '../utils/startHookServer';
import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import { getProjectPath } from '../utils/path';
import {
  runClaudeUnifiedTerminalSession,
  shouldProbeTmuxForClaudeUnifiedDefaultHost,
} from './runClaudeUnifiedTerminalSession';
import { surfaceClaudeUnifiedTerminalRuntimeIssue } from './surfaceClaudeUnifiedTerminalRuntimeIssue';
import type {
  BlockedApplyStarvationInfo,
  ClaudeUnifiedRuntimeConfigOutcomeEvent,
  ClaudeUnifiedRuntimeControlApplyResult,
} from './runtimeControlIntegration';
import { createClaudeOwnComposerTextLog } from './ownComposerTextLog';
import {
  ClaudeUnifiedTerminalReadinessTimeoutError,
  isClaudeUnifiedTerminalReadinessTimeoutError,
} from './createClaudeUnifiedTerminalReadinessBridge';
import { reloadConfiguration } from '@/configuration';

type ReadinessEnvSnapshot = Readonly<{
  timeout: string | undefined;
  extended: string | undefined;
  grace: string | undefined;
  poll: string | undefined;
}>;

function restoreReadinessEnv(previous: ReadinessEnvSnapshot): void {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore('HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS', previous.timeout);
  restore('HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_EXTENDED_TIMEOUT_MS', previous.extended);
  restore('HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_PROGRESS_GRACE_MS', previous.grace);
  restore('HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_POLL_MS', previous.poll);
  reloadConfiguration();
}

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: loggerMock,
}));

const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

const interactiveClaudeScreen = [
  'Some previous Claude output',
  '',
  'What would you like to work on?',
  '> ',
].join('\n');

function setProcessPlatform(platform: NodeJS.Platform): void {
  if (!originalProcessPlatformDescriptor) {
    throw new Error('process.platform descriptor is unavailable');
  }
  Object.defineProperty(process, 'platform', {
    ...originalProcessPlatformDescriptor,
    value: platform,
  });
}

function createAbortableSignal(): AbortController {
  return new AbortController();
}

class FakeProcessSignals {
  private readonly listeners = new Map<string, Set<() => void>>();

  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    const wrapped = () => {
      this.removeListener(event, wrapped);
      listener();
    };
    listeners.add(wrapped);
    this.listeners.set(event, listeners);
  }

  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener();
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('runClaudeUnifiedTerminalSession', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    if (originalProcessPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalProcessPlatformDescriptor);
    }
    loggerMock.debug.mockClear();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a terminal host, binds TerminalInputInjectionV1, and injects the first queued prompt', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    let nextMessageCallCount = 0;
    let consumed = false;
    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      claudeArgs: ['--model', 'sonnet'],
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'line one\nline two',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude', '--model', 'sonnet'],
        spawnEnv: { DISABLE_AUTOUPDATER: '1' },
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    expect(adapter.createOrAttachHost).toHaveBeenCalledWith({
      sessionName: 'happier-claude-session-test',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/bin/claude', '--model', 'sonnet'],
      spawnEnv: { DISABLE_AUTOUPDATER: '1' },
      isolatedEnv: true,
    });
    expect(adapter.injectUserPrompt).toHaveBeenCalledTimes(1);
    expect(injected).toEqual(['line one\nline two']);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_resolved',
      properties: {
        kind: 'tmux',
        platform: process.platform,
        preference: 'tmux',
        reason: 'test',
      },
    });
  });

  it('marks risky during-write failures as possible short own composer residue', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const ownComposerTexts = {
      record: vi.fn(),
      matches: vi.fn(() => false),
      recordPossiblePartialResidue: vi.fn(),
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const attemptedPrompt = `please produce the full report ${'x'.repeat(320)}`;
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({
        status: 'failed',
        reason: 'timeout',
        phase: 'during_write',
        duplicateRisk: 'possible',
        recoverable: true,
      }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: attemptedPrompt,
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      ownComposerTexts: ownComposerTexts as unknown as ReturnType<typeof createClaudeOwnComposerTextLog>,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => ownComposerTexts.recordPossiblePartialResidue.mock.calls.length === 1, 5_000);
      expect(ownComposerTexts.record).toHaveBeenCalledWith(attemptedPrompt);
      expect(ownComposerTexts.recordPossiblePartialResidue).toHaveBeenCalledWith(attemptedPrompt);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('marks provider-acceptance pending prompts as possible short own composer residue', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const ownComposerTexts = {
      record: vi.fn(),
      matches: vi.fn(() => false),
      recordPossiblePartialResidue: vi.fn(),
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const providerPendingPrompt = `please continue from the pending prompt ${'x'.repeat(320)}`;
    const providerPendingInput = {
      message: providerPendingPrompt,
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      providerAcceptancePending: true,
    } as const;
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return providerPendingInput;
      },
      ownComposerTexts: ownComposerTexts as unknown as ReturnType<typeof createClaudeOwnComposerTextLog>,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => ownComposerTexts.recordPossiblePartialResidue.mock.calls.length === 1, 1_000);
      expect(ownComposerTexts.record).toHaveBeenCalledWith(providerPendingPrompt);
      expect(ownComposerTexts.recordPossiblePartialResidue).toHaveBeenCalledWith(providerPendingPrompt, {
        minPrefixChars: 16,
      });
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('normalizes native Windows tmux preference to auto before resolving a host', async () => {
    setProcessPlatform('win32');
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const resolvedPreferences: Array<'auto' | 'tmux' | 'zellij'> = [];
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello from Windows',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async (preference) => {
        resolvedPreferences.push(preference);
        if (preference === 'tmux') {
          return {
            status: 'disabled',
            reason: 'tmux_unsupported_on_windows',
            message: "tmux is not supported on native Windows; use 'auto' or 'zellij', or install WSL2.",
          };
        }
        return { status: 'resolved', adapter, reason: 'windows_zellij' };
      },
      buildSpawn: async () => ({
        spawnArgv: ['C:\\Tools\\claude.exe'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    expect(resolvedPreferences).toEqual(['auto']);
    expect(adapter.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'happier-claude-session-test',
      workingDirectory: '/workspace/project',
      spawnArgv: ['C:\\Tools\\claude.exe'],
    }));
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_resolved',
      properties: {
        kind: 'zellij',
        platform: 'win32',
        preference: 'auto',
        reason: 'windows_zellij',
      },
    });
  });

  it('does not probe tmux while resolving native Windows default terminal hosts', () => {
    expect(shouldProbeTmuxForClaudeUnifiedDefaultHost('win32')).toBe(false);
    expect(shouldProbeTmuxForClaudeUnifiedDefaultHost('linux')).toBe(true);
    expect(shouldProbeTmuxForClaudeUnifiedDefaultHost('darwin')).toBe(true);
  });

  it('registers a user-authorized terminal composer clear runtime control while the host is live', async () => {
    const abortController = createAbortableSignal();
    const specialKeysSent: string[] = [];
    const registeredClear: {
      current: ((request: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown) | null;
    } = { current: null };
    const availabilitySnapshots: Array<Readonly<{ available: boolean; reason: 'unsafe_window' | 'user_terminal_draft' | null }>> = [];
    let unregisterCount = 0;
    let currentScreen = [
      'Some previous Claude output',
      '╭───────────────────────────────────────────────────────────────────────────╮',
      '│ > draft typed directly in the terminal │',
      '╰───────────────────────────────────────────────────────────────────────────╯',
    ].join('\n');
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: currentScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      createControlPort: vi.fn(() => ({
        hostKind: 'tmux' as const,
        sendLiteralText: vi.fn(async () => ({ status: 'sent', at: Date.now() } as const)),
        sendRawSequence: vi.fn(async () => ({ status: 'sent', at: Date.now() } as const)),
        sendSpecialKey: vi.fn(async (key: string) => {
          specialKeysSent.push(key);
          if (key === 'Escape') currentScreen = interactiveClaudeScreen;
          return { status: 'sent', at: Date.now() } as const;
        }),
        captureScreen: vi.fn(async () => ({
          status: 'captured',
          capture: { text: currentScreen, capturedAtMs: Date.now(), hostKind: 'tmux' as const },
        } as const)),
      })),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'sess-clear',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'first prompt',
        mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      createController: () => ({
        run: async () => {},
        dispose: async () => {},
      }),
      registerTerminalComposerClearRuntimeControl: (handler) => {
        registeredClear.current = handler;
        return () => {
          unregisterCount += 1;
          registeredClear.current = null;
        };
      },
      onInFlightSteerAvailabilitySnapshot: (snapshot) => {
        availabilitySnapshots.push(snapshot);
      },
    });

    try {
      await waitUntil(() => registeredClear.current !== null);
      const clearTerminalComposer = registeredClear.current;
      if (!clearTerminalComposer) throw new Error('terminal composer clear handler was not registered');
      const result = await clearTerminalComposer({ sessionId: 'sess-clear' });
      expect(result).toMatchObject({ ok: true, status: 'cleared', sessionId: 'sess-clear' });
      expect(specialKeysSent).toEqual(['Escape']);
      expect(availabilitySnapshots).toContainEqual({ available: true, reason: null });
    } finally {
      abortController.abort();
      await sessionPromise;
    }

    expect(unregisterCount).toBe(1);
    expect(registeredClear.current).toBeNull();
  });

  it('wakes a draft-guard deferred prompt when the user-authorized terminal composer clear succeeds after a style-unavailable plain capture', async () => {
    const abortController = createAbortableSignal();
    const injectedInputs: string[] = [];
    const specialKeysSent: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    let currentCursor: { x: number; y: number } | undefined;
    const foreignDraftScreen = [
      'Some previous Claude output',
      '╭───────────────────────────────────────────────╮',
      '│ ❯ half-typed terminal draft                    │',
      '╰───────────────────────────────────────────────╯',
    ].join('\n');
    const telemetry = { emit: vi.fn() };
    const registeredClear: {
      current: ((
        request: Readonly<SessionTerminalComposerClearRequestV1>,
      ) => Promise<SessionTerminalComposerClearResultV1>) | null;
    } = { current: null };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injectedInputs.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: currentScreen === interactiveClaudeScreen,
        currentInput: currentScreen,
        observedAt: Date.now(),
        ...(currentCursor ? { cursor: currentCursor } : {}),
      })),
      interruptTurn: vi.fn(async () => {}),
      createControlPort: vi.fn(() => ({
        hostKind: 'tmux' as const,
        sendLiteralText: vi.fn(async () => ({ status: 'sent', at: Date.now() } as const)),
        sendRawSequence: vi.fn(async () => ({ status: 'sent', at: Date.now() } as const)),
        sendSpecialKey: vi.fn(async (key: string) => {
          specialKeysSent.push(key);
          if (key === 'Escape') {
            currentScreen = interactiveClaudeScreen;
            currentCursor = undefined;
          }
          return { status: 'sent', at: Date.now() } as const;
        }),
        captureScreen: vi.fn(async () => ({
          status: 'captured',
          capture: {
            text: currentScreen,
            capturedAtMs: Date.now(),
            hostKind: 'tmux' as const,
            ...(currentCursor ? { cursor: currentCursor } : {}),
          },
        } as const)),
      })),
      dispose: vi.fn(async () => {}),
    };
    let releaseSecondMessage!: (value: { message: string; mode: EnhancedMode }) => void;
    let messageIndex = 0;
    const nextMessage = vi.fn((): Promise<{ message: string; mode: EnhancedMode } | null> => {
      messageIndex += 1;
      if (messageIndex === 1) {
        return Promise.resolve({
          message: 'warm up the ready session',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
        });
      }
      if (messageIndex === 2) {
        return new Promise<{ message: string; mode: EnhancedMode }>((resolve) => {
          releaseSecondMessage = resolve;
        });
      }
      return new Promise<{ message: string; mode: EnhancedMode } | null>(() => {});
    });

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'sess-clear-wake',
      signal: abortController.signal,
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 25,
      telemetry,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      registerTerminalComposerClearRuntimeControl: (handler) => {
        registeredClear.current = handler;
        return () => {
          registeredClear.current = null;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      await waitUntil(() => registeredClear.current !== null, 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injectedInputs.length === 1, 5_000);
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      subscribedHook?.({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      await waitUntil(() => nextMessage.mock.calls.length >= 2, 5_000);
      currentScreen = foreignDraftScreen;
      currentCursor = { x: 25, y: 1 };
      releaseSecondMessage({
        message: 'deliver immediately after clear',
        mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
      });
      await waitUntil(() => telemetry.emit.mock.calls.some((call) => (
        call[0]?.name === 'unified.injection.draft_guard'
        && call[0]?.properties?.status === 'capture_style_unavailable'
      )), 5_000);
      expect(injectedInputs).toEqual(['warm up the ready session']);

      const clearTerminalComposer = registeredClear.current;
      if (!clearTerminalComposer) throw new Error('terminal composer clear handler was not registered');
      const result = await clearTerminalComposer({ sessionId: 'sess-clear-wake' });

      expect(result).toMatchObject({ ok: true, status: 'cleared', sessionId: 'sess-clear-wake' });
      expect(specialKeysSent).toContain('Escape');
      await waitUntil(() => injectedInputs.length === 2, 1_000);
      expect(injectedInputs).toEqual([
        'warm up the ready session',
        'deliver immediately after clear',
      ]);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('creates the terminal host from initial mode before any queued UI message resolves', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseQueuedMessage!: (value: {
      message: string;
      mode: EnhancedMode;
    }) => void;
    const nextMessage = vi.fn(() => new Promise<{
      message: string;
      mode: EnhancedMode;
    }>((resolve) => {
      releaseQueuedMessage = resolve;
    }));

    const sessionPromise = runClaudeUnifiedTerminalSession<EnhancedMode>({
      path: '/workspace/project',
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
        model: 'sonnet',
      },
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async ({ first }) => ({
        spawnArgv: ['/bin/claude', '--model', first.mode.model ?? ''],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
    });

    try {
      await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
      expect(adapter.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
        spawnArgv: ['/bin/claude', '--model', 'sonnet'],
      }));
      expect(adapter.injectUserPrompt).not.toHaveBeenCalled();

      releaseQueuedMessage({
        message: 'queued after startup',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
          model: 'sonnet',
        },
      });

      await waitUntil(() => vi.mocked(adapter.injectUserPrompt).mock.calls.length === 1);
      expect(adapter.injectUserPrompt).toHaveBeenCalledWith(handle, expect.objectContaining({
        text: 'queued after startup',
      }));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('injects the first queued prompt after empty startup before SessionStart when terminal input is ready', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseQueuedMessage!: (value: {
      message: string;
      mode: EnhancedMode;
    }) => void;
    const nextMessage = vi.fn(() => new Promise<{
      message: string;
      mode: EnhancedMode;
    }>((resolve) => {
      releaseQueuedMessage = resolve;
    }));

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      sessionId: null,
      transcriptPath: null,
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {},
    });

    try {
      await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);

      releaseQueuedMessage({
        message: 'queued before SessionStart',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      });

      await waitUntil(() => injected.length === 1, 2_000);
      expect(injected).toEqual(['queued before SessionStart']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('imports a prompt-correlated transcript when empty-started Claude does not emit SessionStart', async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const abortController = createAbortableSignal();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-no-hook-transcript-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    const prompt = 'Please reply with exactly: QA_LINUX_TMUX_FIXED_OK';
    const claudeSessionId = '33333333-3333-4333-8333-333333333333';
    const transcriptPath = join(projectDir, `${claudeSessionId}.jsonl`);
    const importedMessages: RawJSONLines[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        await writeFile(transcriptPath, `${[
          {
            type: 'user',
            uuid: 'prompt-correlated-user-row',
            sessionId: claudeSessionId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'user',
              content: input.text,
            },
          },
          {
            type: 'assistant',
            uuid: 'prompt-correlated-assistant-row',
            sessionId: claudeSessionId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'QA_LINUX_TMUX_FIXED_OK' }],
              stop_reason: 'end_turn',
            },
          },
        ].map((message) => JSON.stringify(message)).join('\n')}\n`);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseQueuedMessage!: (value: {
      message: string;
      mode: EnhancedMode;
    }) => void;
    const nextMessage = vi.fn(() => new Promise<{
      message: string;
      mode: EnhancedMode;
    }>((resolve) => {
      releaseQueuedMessage = resolve;
    }));

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: null,
      transcriptPath: null,
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {},
      onMessage: (message) => {
        importedMessages.push(message);
        if (message.type === 'assistant') {
          abortController.abort();
        }
      },
    });

    try {
      await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
      releaseQueuedMessage({
        message: prompt,
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      });

      await waitUntil(
        () => importedMessages.some((message) => message.type === 'assistant' && message.uuid === 'prompt-correlated-assistant-row'),
        5_000,
      );
      expect(importedMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'user',
          uuid: 'prompt-correlated-user-row',
        }),
        expect.objectContaining({
          type: 'assistant',
          uuid: 'prompt-correlated-assistant-row',
        }),
      ]));
    } finally {
      abortController.abort();
      await sessionPromise;
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  it('confirms a known resumed prompt from transcript when Claude never emits SessionStart', async () => {
    const abortController = createAbortableSignal();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-known-resume-no-sessionstart-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const prompt = 'Please continue the known resumed session from the current checkpoint.';
    const claudeSessionId = '44444444-4444-4444-8444-444444444444';
    const transcriptPath = join(dir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');

    const injected: string[] = [];
    const onPromptAcceptedByProvider = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        await appendFile(transcriptPath, `${JSON.stringify({
          type: 'user',
          uuid: 'known-resume-accepted-user-row',
          sessionId: claudeSessionId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: input.text,
          },
        })}\n`);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: claudeSessionId,
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: prompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          maxUserMessageSeq: 2039,
          userMessageLocalIds: ['known-resume-local-id'],
        };
      },
      onMessage: vi.fn(),
      onPromptAcceptedByProvider,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      await waitUntil(() => injected.length === 1, 5_000);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1, 2_000);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: prompt,
        maxUserMessageSeq: 2039,
        userMessageLocalIds: ['known-resume-local-id'],
      });
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('confirms provider acceptance when the transcript row appears before terminal injection returns', async () => {
    const abortController = createAbortableSignal();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-early-transcript-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const prompt = [
      'please add support for opencode and claude oauth/setup-token',
      '',
      'Then proceed with the complete implementation plan.',
    ].join('\r\n');
    const persistedPrompt = prompt.replace(/\r\n/g, '\n');
    const claudeSessionId = '55555555-5555-4555-8555-555555555555';
    const transcriptPath = join(dir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');

    const injected: string[] = [];
    const onPromptAcceptedByProvider = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        await appendFile(transcriptPath, `${JSON.stringify({
          type: 'user',
          uuid: 'early-transcript-accepted-user-row',
          sessionId: claudeSessionId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: persistedPrompt,
          },
        })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 75));
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: claudeSessionId,
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: prompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          maxUserMessageSeq: 971,
          userMessageLocalIds: ['early-transcript-local-id'],
        };
      },
      onMessage: vi.fn(),
      onPromptAcceptedByProvider,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      await waitUntil(() => injected.length === 1, 5_000);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1, 2_000);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: prompt,
        maxUserMessageSeq: 971,
        userMessageLocalIds: ['early-transcript-local-id'],
      });
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('does not retry a seqless pending prompt when the provider transcript row arrives after injection', async () => {
    const abortController = createAbortableSignal();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-seqless-pending-transcript-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const prompt = 'Reply with exactly: QA_DUP_FIX_AFTER_LINE_CLEAR_20260626';
    const claudeSessionId = '66666666-6666-4666-8666-666666666666';
    const transcriptPath = join(dir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');

    const injected: string[] = [];
    const onPromptAcceptedByProvider = vi.fn();
    const onTerminalInjectionFailure = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        setTimeout(() => {
          void appendFile(transcriptPath, `${JSON.stringify({
            type: 'user',
            uuid: `seqless-pending-accepted-user-row-${injected.length}`,
            promptId: `seqless-pending-prompt-${injected.length}`,
            sessionId: claudeSessionId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'user',
              content: input.text,
            },
          })}\n`);
        }, 25).unref?.();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: claudeSessionId,
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: prompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          maxUserMessageSeq: null,
          userMessageLocalIds: ['seqless-pending-local-id'],
        };
      },
      onMessage: vi.fn(),
      onPromptAcceptedByProvider,
      onTerminalInjectionFailure,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      providerAcceptanceTimeoutMs: 100,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      await waitUntil(() => injected.length === 1, 5_000);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(injected).toEqual([prompt]);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: prompt,
        maxUserMessageSeq: null,
        userMessageLocalIds: ['seqless-pending-local-id'],
      });
      expect(onTerminalInjectionFailure).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('confirms a known resumed prompt from the canonical transcript path when transcriptPath is not passed', async () => {
    const abortController = createAbortableSignal();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-known-resume-canonical-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const prompt = 'Please continue the known resumed session from the canonical transcript.';
    const claudeSessionId = '55555555-5555-4555-8555-555555555555';
    const transcriptPath = join(projectDir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    const injected: string[] = [];
    const onPromptAcceptedByProvider = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        await appendFile(transcriptPath, `${JSON.stringify({
          type: 'user',
          uuid: 'known-resume-canonical-accepted-user-row',
          sessionId: claudeSessionId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: input.text,
          },
        })}\n`);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: claudeSessionId,
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: prompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          maxUserMessageSeq: 2040,
          userMessageLocalIds: ['known-resume-canonical-local-id'],
        };
      },
      onMessage: vi.fn(),
      onPromptAcceptedByProvider,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      await waitUntil(() => injected.length === 1, 5_000);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1, 2_000);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: prompt,
        maxUserMessageSeq: 2040,
        userMessageLocalIds: ['known-resume-canonical-local-id'],
      });
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  it('passes the resolved default coding prompt into the terminal spawn builder', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: 1 } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const options = {
      path: '/workspace/project',
      systemPromptText: 'Resolved default coding prompt',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async (params) => {
        expect(params.systemPromptText).toBe('Resolved default coding prompt');
        return {
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        };
      },
      createSessionName: () => 'happier-claude-session-test',
    } satisfies Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      systemPromptText: string;
    };

    await runClaudeUnifiedTerminalSession(options);
  });

  it('persists terminal-host attachment info by Happy session id once the host is created', async () => {
    const abortController = createAbortableSignal();
    const persistTerminalHostAttachmentInfo = vi.fn(async () => {});
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const options = {
      path: '/workspace/project',
      sessionId: null,
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo,
    } as Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      happySessionId: string;
      persistTerminalHostAttachmentInfo: typeof persistTerminalHostAttachmentInfo;
    };

    await runClaudeUnifiedTerminalSession(options);

    expect(persistTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-claude-session-test:unified-window',
        },
      },
    });
  });

  it('adopts a live existing terminal host for endpoint-rebound recovery without relaunching Claude', async () => {
    const abortController = createAbortableSignal();
    const existingHandle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-existing-session',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        throw new Error('fresh host must not be created when adopt-first recovery is available');
      }),
      adoptExistingHost: vi.fn(async () => existingHandle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const persistTerminalHostAttachmentInfo = vi.fn(async () => {});
    const buildSpawn = vi.fn(async () => ({
      spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', '/tmp/fresh-hooks-launch.json'],
      spawnEnv: { CLAUDE_CONFIG_DIR: '/tmp/connected-service-claude-home' },
    }));
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      adoptExistingTerminalHost: true,
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello existing terminal',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn,
      createSessionName: () => 'happier-claude-existing-session',
      readTerminalHostAttachmentInfo: async () => ({
        version: 1,
        sessionId: 'happy-session-id',
        terminal: {
          mode: 'tmux',
          tmux: {
            target: 'happier-claude-existing-session:unified-window',
          },
        },
        updatedAt: 1,
      }),
      persistTerminalHostAttachmentInfo,
    });

    try {
      await waitUntil(() => abortController.signal.aborted, 5_000);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }

    expect(adapter.evaluateLiveness).toHaveBeenCalledWith(expect.objectContaining({
      kind: existingHandle.kind,
      sessionName: existingHandle.sessionName,
      paneId: existingHandle.paneId,
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    }));
    expect(buildSpawn).not.toHaveBeenCalled();
    expect(adapter.adoptExistingHost).toHaveBeenCalledWith(expect.objectContaining({
      kind: existingHandle.kind,
      sessionName: existingHandle.sessionName,
      paneId: existingHandle.paneId,
    }));
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(persistTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-claude-existing-session:unified-window',
        },
      },
    });
  });

  it('removes stale terminal attachment info and falls back to a fresh host when the saved pane is dead', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-fresh-session',
      paneId: 'fresh-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      adoptExistingHost: vi.fn(async () => {
        throw new Error('stale pane must not be adopted');
      }),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi
        .fn()
        .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 1 })
        .mockResolvedValue({ paneAlive: true, observedAt: 2 }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const removeTerminalHostAttachmentInfo = vi.fn(async () => {});

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello fresh terminal',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', '/tmp/fresh.json'],
        spawnEnv: { CLAUDE_CONFIG_DIR: '/tmp/connected-service-claude-home' },
      }),
      createSessionName: () => 'happier-claude-fresh-session',
      readTerminalHostAttachmentInfo: async () => ({
        version: 1,
        sessionId: 'happy-session-id',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happier-claude-stale-session:dead-window' },
        },
        updatedAt: 1,
      }),
      removeTerminalHostAttachmentInfo,
    });

    expect(adapter.adoptExistingHost).not.toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'tmux',
      sessionName: 'happier-claude-stale-session',
      paneId: 'dead-window',
    }));
    expect(vi.mocked(adapter.dispose).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.createOrAttachHost).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(removeTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: {
        mode: 'tmux',
        tmux: { target: 'happier-claude-stale-session:dead-window' },
      },
    });
    expect(adapter.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'happier-claude-fresh-session',
      spawnEnv: { CLAUDE_CONFIG_DIR: '/tmp/connected-service-claude-home' },
    }));
  });

  it('keeps terminal attachment info when an inconclusive startup probe is followed by a live pane', async () => {
    const abortController = createAbortableSignal();
    const existingHandle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-existing-session',
      paneId: 'transient-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        throw new Error('fresh host must not be created after a single inconclusive probe');
      }),
      adoptExistingHost: vi.fn(async () => existingHandle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi
        .fn()
        .mockResolvedValueOnce({ paneAlive: false, probeInconclusive: true, observedAt: 1 })
        .mockResolvedValue({ paneAlive: true, observedAt: 2 }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const removeTerminalHostAttachmentInfo = vi.fn(async () => {});

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      adoptExistingTerminalHost: true,
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello adopted terminal',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', '/tmp/fresh.json'],
        spawnEnv: { CLAUDE_CONFIG_DIR: '/tmp/connected-service-claude-home' },
      }),
      createSessionName: () => 'happier-claude-existing-session',
      readTerminalHostAttachmentInfo: async () => ({
        version: 1,
        sessionId: 'happy-session-id',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happier-claude-existing-session:transient-window' },
        },
        updatedAt: 1,
      }),
      removeTerminalHostAttachmentInfo,
    });

    expect(adapter.evaluateLiveness).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionName: 'happier-claude-existing-session',
      paneId: 'transient-window',
    }));
    expect(adapter.evaluateLiveness).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionName: 'happier-claude-existing-session',
      paneId: 'transient-window',
    }));
    expect(adapter.adoptExistingHost).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'happier-claude-existing-session',
      paneId: 'transient-window',
    }));
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('aborts adopt fallback instead of spawning a second Claude when the retained pane is still alive', async () => {
    const existingHandle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-existing-session',
      paneId: 'live-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        throw new Error('fresh host must not be created while retained Claude is alive');
      }),
      adoptExistingHost: vi.fn(async () => {
        throw new Error('adopt failed transiently');
      }),
      injectUserPrompt: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      adoptExistingTerminalHost: true,
      nextMessage: async () => ({
        message: 'hello existing terminal',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', '/tmp/fresh.json'],
        spawnEnv: { CLAUDE_CONFIG_DIR: '/tmp/connected-service-claude-home' },
      }),
      createSessionName: () => 'happier-claude-existing-session',
      readTerminalHostAttachmentInfo: async () => ({
        version: 1,
        sessionId: 'happy-session-id',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happier-claude-existing-session:live-window' },
        },
        updatedAt: 1,
      }),
    })).rejects.toThrow('adopt failed transiently');

    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('aborts relaunch fallback instead of spawning a second Claude when relaunch cannot confirm the old pane died', async () => {
    const existingHandle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-existing-session',
      paneId: 'live-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        throw new Error('fresh host must not be created after failed relaunch');
      }),
      relaunchExistingHost: vi.fn(async () => {
        throw new Error('killWindow false');
      }),
      injectUserPrompt: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      nextMessage: async () => ({
        message: 'hello existing terminal',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', '/tmp/fresh.json'],
        spawnEnv: { CLAUDE_CONFIG_DIR: '/tmp/connected-service-claude-home' },
      }),
      createSessionName: () => 'happier-claude-existing-session',
      readTerminalHostAttachmentInfo: async () => ({
        version: 1,
        sessionId: 'happy-session-id',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happier-claude-existing-session:live-window' },
        },
        updatedAt: 1,
      }),
    })).rejects.toThrow('killWindow false');

    expect(adapter.relaunchExistingHost).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: existingHandle.kind,
        sessionName: existingHandle.sessionName,
        paneId: existingHandle.paneId,
      }),
      expect.objectContaining({
        sessionName: 'happier-claude-existing-session',
      }),
    );
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('removes matching terminal-host attachment info after terminal host disposal', async () => {
    const abortController = createAbortableSignal();
    const persistTerminalHostAttachmentInfo = vi.fn(async () => {});
    const removeTerminalHostAttachmentInfo = vi.fn(async () => {});
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'zellij',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo,
      removeTerminalHostAttachmentInfo,
    });

    const expectedTerminal = {
      mode: 'zellij',
      zellij: {
        sessionName: 'happier-claude-session-test',
        paneId: 'terminal_7',
      },
    };
    expect(persistTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: expectedTerminal,
    });
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(removeTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: expectedTerminal,
    });
  });

  it('notifies when the terminal host is ready with attachable metadata', async () => {
    const abortController = createAbortableSignal();
    const onTerminalHostReady = vi.fn();
    const clearSessionMarkerTerminalHostHealth = vi.fn(async () => true);
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const options = {
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo: vi.fn(async () => {}),
      clearSessionMarkerTerminalHostHealth,
      onTerminalHostReady,
    } as Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      onTerminalHostReady: typeof onTerminalHostReady;
    };

    await runClaudeUnifiedTerminalSession(options);

    expect(clearSessionMarkerTerminalHostHealth).toHaveBeenCalledWith({
      pid: process.pid,
      sessionId: 'happy-session-id',
    });
    expect(clearSessionMarkerTerminalHostHealth.mock.invocationCallOrder[0]).toBeLessThan(
      onTerminalHostReady.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(onTerminalHostReady).toHaveBeenCalledWith({
      handle,
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-claude-session-test:unified-window',
        },
      },
    });
  });

  it('starts the unified controller before notifying foreground attach readiness', async () => {
    const abortController = createAbortableSignal();
    const events: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      signal: abortController.signal,
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo: vi.fn(async () => {}),
      createController: () => ({
        run: async () => {
          events.push('controller-run');
        },
        dispose: async () => {},
      }),
      onTerminalHostReady: () => {
        events.push('host-ready');
        abortController.abort();
      },
    });

    expect(events).toEqual(['controller-run', 'host-ready']);
  });

  it('disposes the terminal host and hook subscription when setup fails after host creation', async () => {
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let hookUnsubscribed = false;
    const setTurnInterrupt = vi.fn();

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {
        hookUnsubscribed = true;
      },
      setTurnInterrupt,
      createController: () => {
        throw new Error('controller setup failed');
      },
    })).rejects.toThrow('controller setup failed');

    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(hookUnsubscribed).toBe(true);
    expect(setTurnInterrupt).toHaveBeenLastCalledWith(null);
  });

  it('binds process signal cleanup immediately after terminal host creation', async () => {
    const processSignals = new FakeProcessSignals();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let disposedDuringControllerSetup = false;

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      createController: async () => {
        processSignals.emit('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 10));
        disposedDuringControllerSetup = vi.mocked(adapter.dispose).mock.calls.length > 0;
        throw new Error('controller setup failed');
      },
    })).rejects.toThrow('controller setup failed');

    expect(disposedDuringControllerSetup).toBe(true);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('cleans up provisional and completed terminal hosts when a process signal arrives during host creation', async () => {
    const processSignals = new FakeProcessSignals();
    const hostCreated = createDeferred<TerminalHostHandle>();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => hostCreated.promise),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const createController = vi.fn();

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      createController,
    });

    await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
    processSignals.emit('SIGTERM');
    await waitUntil(() => vi.mocked(adapter.dispose).mock.calls.length === 1);
    hostCreated.resolve(handle);
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenNthCalledWith(1, {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
      },
    });
    expect(adapter.dispose).toHaveBeenNthCalledWith(2, handle);
    expect(createController).not.toHaveBeenCalled();
    expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
  });

  it('targets the requested tmux window during provisional process-signal cleanup', async () => {
    const processSignals = new FakeProcessSignals();
    const hostCreated = createDeferred<TerminalHostHandle>();
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => hostCreated.promise),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      createController: vi.fn(),
    });

    await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
    processSignals.emit('SIGTERM');
    await waitUntil(() => vi.mocked(adapter.dispose).mock.calls.length === 1);
    hostCreated.resolve({
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    });
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenNthCalledWith(1, {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
      },
    });
  });

  it('does not continue into controller setup when a process signal arrives while persisting terminal metadata', async () => {
    const processSignals = new FakeProcessSignals();
    const persistStarted = createDeferred<void>();
    const persistFinished = createDeferred<void>();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const createController = vi.fn(() => {
      throw new Error('controller should not be created after SIGTERM');
    });

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      persistTerminalHostAttachmentInfo: async () => {
        persistStarted.resolve();
        await persistFinished.promise;
      },
      createController,
    });

    await persistStarted.promise;
    processSignals.emit('SIGTERM');
    persistFinished.resolve();
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(createController).not.toHaveBeenCalled();
    expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
  });

  it('disposes the terminal host on process SIGTERM even when the caller signal was not aborted', async () => {
    const abortController = createAbortableSignal();
    const processSignals = new FakeProcessSignals();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => ({ status: 'injected', at: Date.now(), bytesWritten: input.text.length }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'queued prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
    });

    await waitUntil(() => vi.mocked(adapter.injectUserPrompt).mock.calls.length === 1);
    processSignals.emit('SIGTERM');

    await waitUntil(() => vi.mocked(adapter.dispose).mock.calls.length === 1);
    await sessionPromise;

    expect(abortController.signal.aborted).toBe(false);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('logs terminal disposal failures observed during process signal cleanup', async () => {
    const abortController = createAbortableSignal();
    const processSignals = new FakeProcessSignals();
    const disposalError = new Error('terminal cleanup failed');
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => ({ status: 'injected', at: Date.now(), bytesWritten: input.text.length }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {
        throw disposalError;
      }),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'queued prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
    });

    await waitUntil(() => vi.mocked(adapter.injectUserPrompt).mock.calls.length === 1);
    processSignals.emit('SIGINT');

    await waitUntil(() => loggerMock.debug.mock.calls.some((call) =>
      String(call[0]).includes('process signal cleanup')
      && call[1] === disposalError,
    ));
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('shares and disposes one pre-host Claude hook subscription across lifecycle bridges', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-cleanup-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_cleanup.jsonl');
    await writeFile(transcriptPath, '');

    const abortController = createAbortableSignal();
    let subscriptionCount = 0;
    let unsubscribeCount = 0;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: 'sess_cleanup',
      transcriptPath,
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => {
        subscriptionCount += 1;
        return () => {
          unsubscribeCount += 1;
        };
      },
      onMessage: vi.fn(),
    });

    await waitUntil(() => subscriptionCount === 1);
    abortController.abort();

    await sessionPromise;
    expect(subscriptionCount).toBe(1);
    expect(unsubscribeCount).toBe(1);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('waits for terminal startup readiness before injecting the first queued prompt', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let terminalReady = false;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: terminalReady,
        currentInput: terminalReady ? interactiveClaudeScreen : 'Claude is restoring the previous session',
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      sessionId: 'claude-session-id',
      transcriptPath: '/tmp/claude-session.jsonl',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'resume follow-up',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(injected).toEqual([]);
      terminalReady = true;
      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['resume follow-up']);
      expect(adapter.captureInputState).toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  // Lane N3 (incident cmq8y3nlx/pid-58372): SessionStart proves the host is alive, NOT that the
  // interactive composer is ready. Controls + prompt writes must be held behind the SAME
  // startup-readiness owner (the readiness bridge); typing /effort into a still-initializing TUI
  // orphans the slash picker and cascades into unsafe_overlay loops.
  it('holds runtime controls and prompt injection until the startup readiness owner reports ready', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const applyBeforePromptCalls: number[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let screenReady = false;
    const notReadyScreen = 'Initializing Claude Code…\nLoading workspace configuration';
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: screenReady ? interactiveClaudeScreen : notReadyScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'wait for startup readiness',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: vi.fn(),
        createBridge: () => ({
          applyBeforePrompt: vi.fn(async () => {
            applyBeforePromptCalls.push(Date.now());
            return { promptMayProceed: true } as const;
          }),
          reconcileFromPromptSubmitMetadata: vi.fn(),
          dispose: vi.fn(async () => {}),
        }) as unknown as ReturnType<NonNullable<NonNullable<Parameters<typeof runClaudeUnifiedTerminalSession>[0]['tuiRuntimeControl']>['createBridge']>>,
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      // Lifecycle observations (e.g. compaction/idle markers from a resume) can mark the
      // arbiter's heuristic readiness while the TUI is still initializing — the incident's
      // premature-typing path. The startup-readiness owner must still hold the gate.
      hook({
        hook_event_name: 'PostCompact',
        session_id: 'claude-session-id',
      });

      // SessionStart observed but the composer is NOT ready: neither controls nor the prompt
      // may be typed into the TUI.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(applyBeforePromptCalls).toEqual([]);
      expect(injected).toEqual([]);

      screenReady = true;
      await waitUntil(() => injected.length === 1, 5_000);
      expect(applyBeforePromptCalls.length).toBeGreaterThan(0);
      expect(injected).toEqual(['wait for startup readiness']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('preserves runtime-control blockedReason and pending local ids on before-prompt starvation', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const starvations: BlockedApplyStarvationInfo[] = [];
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'blocked runtime config prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
          userMessageLocalIds: ['pending-local-runtime-config'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      isCanonicalTurnActive: () => false,
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: vi.fn(),
        blockedApplyStarvationThreshold: 1,
        onBlockedApplyStarvation: (info) => {
          starvations.push(info);
          abortController.abort();
        },
        createBridge: () => ({
          applyBeforePrompt: vi.fn(async () => ({
            promptMayProceed: false,
            attempted: true,
            blockedReason: 'user_draft',
          })),
          reconcileFromPromptSubmitMetadata: vi.fn(),
          dispose: vi.fn(async () => {}),
        }) as unknown as ReturnType<NonNullable<NonNullable<Parameters<typeof runClaudeUnifiedTerminalSession>[0]['tuiRuntimeControl']>['createBridge']>>,
      },
    });

    try {
      await waitUntil(() => starvations.length === 1, 5_000);
      expect(starvations).toEqual([{
        consecutiveBlockedApplies: 1,
        blockedReason: 'user_draft',
        isCanonicalTurnActive: false,
        userMessageLocalIds: ['pending-local-runtime-config'],
      }]);
      expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('delivers the queued prompt when runtime-control apply attempted only non-gating work', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const applyBeforePrompt = vi.fn(async () => ({
      promptMayProceed: true,
      attempted: true,
    } as const));
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'ambient settings must not block me',
          mode: {
            permissionMode: 'default',
            reasoningEffort: 'medium',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: vi.fn(),
        createBridge: () => ({
          applyBeforePrompt,
          reconcileFromPromptSubmitMetadata: vi.fn(),
          dispose: vi.fn(async () => {}),
        }) as unknown as ReturnType<NonNullable<NonNullable<Parameters<typeof runClaudeUnifiedTerminalSession>[0]['tuiRuntimeControl']>['createBridge']>>,
      },
    });

    try {
      await waitUntil(() => injected.length === 1, 5_000);
      expect(applyBeforePrompt).toHaveBeenCalledTimes(1);
      expect(injected).toEqual(['ambient settings must not block me']);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('keeps metadata apply starvation separate from before-prompt delivery starvation', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => ({
        status: 'injected',
        at: Date.now(),
        bytesWritten: input.text.length,
      }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const applyBeforePrompt = vi
      .fn()
      .mockResolvedValueOnce({ promptMayProceed: true, attempted: false } as const)
      .mockResolvedValueOnce({
        promptMayProceed: false,
        attempted: true,
        blockedReason: 'user_draft',
      } as const);
    const applyOutOfBand = vi.fn(async () => ({
      promptMayProceed: false,
      attempted: true,
      blockedReason: 'user_draft',
    } as const));
    const mode: EnhancedMode = {
      permissionMode: 'yolo',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const registeredApply: { current?: (mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult> } = {};
    const starvations: BlockedApplyStarvationInfo[] = [];
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const batches: Array<{
      message: string;
      mode: EnhancedMode;
      userMessageLocalIds: readonly string[];
    }> = [
      {
        message: 'previous delivered prompt',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
        userMessageLocalIds: ['previous-local-id'],
      },
      {
        message: 'genuine blocked delivery',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
        userMessageLocalIds: ['current-delivery-local-id'],
      },
    ];

    const sessionPromise = runClaudeUnifiedTerminalSession<EnhancedMode>({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => batches.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      isCanonicalTurnActive: () => false,
      createController: ({ inputConsumer, inputInjection }) => ({
        run: async () => {
          const firstBatch = await inputConsumer.waitForNextInput({ abortSignal: abortController.signal });
          if (!firstBatch) throw new Error('missing first batch');
          await inputInjection.injectUserPrompt({
            text: firstBatch.message,
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'first' },
            scheduling: {},
          });

          const apply = registeredApply.current;
          if (!apply) throw new Error('metadata runtime mode applier was not registered');
          await apply(mode);
          await apply(mode);

          const secondBatch = await inputConsumer.waitForNextInput({ abortSignal: abortController.signal });
          if (!secondBatch) throw new Error('missing second batch');
          await inputInjection.injectUserPrompt({
            text: secondBatch.message,
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'second' },
            scheduling: {},
          });
          abortController.abort();
        },
        dispose: async () => {},
      }),
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: (event) => events.push(event),
        blockedApplyStarvationThreshold: 1,
        blockedInjectionRetryMs: 5,
        onBlockedApplyStarvation: (info) => {
          starvations.push(info);
        },
        registerMetadataRuntimeModeApplier: (apply) => {
          registeredApply.current = apply;
        },
        createBridge: () => ({
          applyBeforePrompt,
          applyPermissionModeForInFlightSteer: vi.fn(async () => ({ status: 'applied' as const })),
          applyOutOfBand,
          reconcileFromPromptSubmitMetadata: vi.fn(),
          reconcileFromStatusline: vi.fn(),
          isControlInFlight: vi.fn(() => false),
          ownsDialog: vi.fn(() => false),
          whenControlIdle: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }),
      },
    });

    try {
      await sessionPromise;
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }

    expect(applyOutOfBand).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      status: 'failed',
      timing: 'queued_until_safe_window',
    }));
    expect(starvations).toEqual([{
      consecutiveBlockedApplies: 1,
      blockedReason: 'user_draft',
      isCanonicalTurnActive: false,
      userMessageLocalIds: ['current-delivery-local-id'],
    }]);
  });

  it('registers a metadata runtime-control applier after the existing bridge is created', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: 1 } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const applyOutOfBand = vi.fn(async () => ({ promptMayProceed: true, attempted: true } as const));
    const registeredApply: { current?: (mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult> } = {};
    const unregister = vi.fn();
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession<EnhancedMode>({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: vi.fn(),
        registerMetadataRuntimeModeApplier: (apply) => {
          registeredApply.current = apply;
          return unregister;
        },
        createBridge: () => ({
          applyBeforePrompt: vi.fn(async () => ({ promptMayProceed: true, attempted: false })),
          applyPermissionModeForInFlightSteer: vi.fn(async () => ({ status: 'applied' as const })),
          applyOutOfBand,
          reconcileFromPromptSubmitMetadata: vi.fn(),
          reconcileFromStatusline: vi.fn(),
          isControlInFlight: vi.fn(() => false),
          ownsDialog: vi.fn(() => false),
          whenControlIdle: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }),
      },
    });

    try {
      await waitUntil(() => registeredApply.current !== undefined);
      const apply = registeredApply.current;
      if (!apply) throw new Error('metadata runtime mode applier was not registered');
      await expect(apply({
        permissionMode: 'yolo',
        claudeUnifiedTerminalHost: 'tmux',
      })).resolves.toEqual({ promptMayProceed: true, attempted: true });
      expect(applyOutOfBand).toHaveBeenCalledWith({
        permissionMode: 'yolo',
        claudeUnifiedTerminalHost: 'tmux',
      });
    } finally {
      abortController.abort();
      await sessionPromise;
    }
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('retries a deferred metadata runtime-control apply at the next completed-turn boundary', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const injected: string[] = [];
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode: EnhancedMode = {
      permissionMode: 'yolo',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const applyOutOfBand = vi
      .fn()
      .mockResolvedValueOnce({ promptMayProceed: false, attempted: true } as const)
      .mockResolvedValueOnce({ promptMayProceed: true, attempted: true } as const);
    const registeredApply: { current?: (mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult> } = {};
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let consumed = false;
    const waitForAbort = async (): Promise<null> => {
      if (abortController.signal.aborted) return null;
      return new Promise<null>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
    };

    const sessionPromise = runClaudeUnifiedTerminalSession<EnhancedMode>({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return waitForAbort();
        consumed = true;
        return {
          message: 'start turn before metadata apply',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 10,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: vi.fn(),
        registerMetadataRuntimeModeApplier: (apply) => {
          registeredApply.current = apply;
        },
        createBridge: () => ({
          applyBeforePrompt: vi.fn(async () => ({ promptMayProceed: true, attempted: false })),
          applyPermissionModeForInFlightSteer: vi.fn(async () => ({ status: 'applied' as const })),
          applyOutOfBand,
          reconcileFromPromptSubmitMetadata: vi.fn(),
          reconcileFromStatusline: vi.fn(),
          isControlInFlight: vi.fn(() => false),
          ownsDialog: vi.fn(() => false),
          whenControlIdle: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }),
      },
    });

    try {
      await waitUntil(() => registeredApply.current !== undefined && typeof subscribedHook === 'function', 5_000);
      const apply = registeredApply.current;
      if (!apply) throw new Error('metadata runtime mode applier was not registered');

      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      await expect(apply(mode)).resolves.toEqual({ promptMayProceed: false, attempted: true });
      expect(applyOutOfBand).toHaveBeenCalledTimes(1);
      expect(applyOutOfBand).toHaveBeenNthCalledWith(1, mode);

      subscribedHook?.({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
        background_tasks: [],
      });

      await waitUntil(() => applyOutOfBand.mock.calls.length === 2, 5_000);
      expect(applyOutOfBand).toHaveBeenNthCalledWith(2, mode);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('retries a deferred metadata runtime-control apply on a bounded timer and emits a failed outcome when no safe boundary arrives', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode: EnhancedMode = {
      permissionMode: 'yolo',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const applyOutOfBand = vi.fn(async () => ({
      promptMayProceed: false,
      attempted: true,
      blockedReason: 'user_draft',
    } as const));
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const registeredApply: { current?: (mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult> } = {};
    let consumed = false;
    const waitForAbort = async (): Promise<null> => {
      if (abortController.signal.aborted) return null;
      return new Promise<null>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
    };

    const sessionPromise = runClaudeUnifiedTerminalSession<EnhancedMode>({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return waitForAbort();
        consumed = true;
        return {
          message: 'start turn before metadata apply',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      tuiRuntimeControl: {
        featureEnabled: true,
        emitRuntimeConfigOutcome: (event) => events.push(event),
        blockedInjectionRetryMs: 5,
        blockedApplyStarvationThreshold: 2,
        registerMetadataRuntimeModeApplier: (apply) => {
          registeredApply.current = apply;
        },
        createBridge: () => ({
          applyBeforePrompt: vi.fn(async () => ({ promptMayProceed: true, attempted: false })),
          applyPermissionModeForInFlightSteer: vi.fn(async () => ({ status: 'applied' as const })),
          applyOutOfBand,
          reconcileFromPromptSubmitMetadata: vi.fn(),
          reconcileFromStatusline: vi.fn(),
          isControlInFlight: vi.fn(() => false),
          ownsDialog: vi.fn(() => false),
          whenControlIdle: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }),
      },
    });

    try {
      await waitUntil(() => registeredApply.current !== undefined, 5_000);
      vi.useFakeTimers();
      const apply = registeredApply.current;
      if (!apply) throw new Error('metadata runtime mode applier was not registered');

      await expect(apply(mode)).resolves.toEqual({
        promptMayProceed: false,
        attempted: true,
        blockedReason: 'user_draft',
      });
      expect(applyOutOfBand).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(5);

      expect(applyOutOfBand).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual(expect.objectContaining({
        status: 'failed',
        timing: 'queued_until_safe_window',
        changes: [expect.objectContaining({
          key: 'permissionMode',
          requested: 'yolo',
          reason: 'user_draft',
        })],
      }));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('registers a structured restart metadata applier when the runtime-control gate is disabled', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: 1 } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const registeredApply: { current?: (mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult> } = {};
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession<EnhancedMode>({
      path: '/workspace/project',
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      tuiRuntimeControl: {
        featureEnabled: false,
        emitRuntimeConfigOutcome: (event) => events.push(event),
        registerMetadataRuntimeModeApplier: (apply) => {
          registeredApply.current = apply;
        },
      },
    });

    try {
      await waitUntil(() => registeredApply.current !== undefined);
      const apply = registeredApply.current;
      if (!apply) throw new Error('metadata runtime mode applier was not registered');
      await expect(apply({
        permissionMode: 'yolo',
        claudeUnifiedTerminalHost: 'tmux',
      })).resolves.toEqual({ promptMayProceed: false, attempted: false });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: 'requires_restart',
        changes: [expect.objectContaining({ key: 'permissionMode', requested: 'yolo' })],
      });
      await expect(apply({
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      })).resolves.toEqual({ promptMayProceed: false, attempted: false });
      expect(events).toHaveLength(1);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('waits for Claude SessionStart before first injection when lifecycle hooks are available', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'wait for session start',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(injected).toEqual([]);
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['wait for session start']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('steers a pending web prompt into a running turn when the screen is actively generating (incident cmq8171vw)', async () => {
    const abortController = createAbortableSignal();
    const injectedInputs: Array<{ text: string; scheduling: { deferredUntilQuietMs?: number | undefined } }> = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    let currentCursor: { x: number; y: number } | undefined;
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injectedInputs.push({ text: input.text, scheduling: { ...input.scheduling } });
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: currentScreen,
        observedAt: Date.now(),
        ...(currentCursor ? { cursor: currentCursor } : {}),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseSteerMessage!: (value: { message: string; mode: EnhancedMode }) => void;
    let messageIndex = 0;
    const nextMessage = vi.fn((): Promise<{ message: string; mode: EnhancedMode } | null> => {
      messageIndex += 1;
      if (messageIndex === 1) {
        return Promise.resolve({
          message: 'start the long task',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
        });
      }
      if (messageIndex === 2) {
        return new Promise<{ message: string; mode: EnhancedMode }>((resolve) => {
          releaseSteerMessage = resolve;
        });
      }
      return new Promise<{ message: string; mode: EnhancedMode } | null>(() => {});
    });

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 25,
      telemetry,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injectedInputs.length === 1, 5_000);
      expect(injectedInputs[0]).toMatchObject({ text: 'start the long task' });

      // Claude accepts the first prompt and a long autonomous turn starts.
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      currentScreen = [
        '● Working through the task…',
        '  reading files, running tests',
        '',
        '✶ Forging… (42s · esc to interrupt)',
      ].join('\n');

      // A web steering message arrives mid-turn. It must reach the TUI now —
      // not be held invisibly until the turn ends.
      await waitUntil(() => nextMessage.mock.calls.length >= 2, 5_000);
      releaseSteerMessage({
        message: 'steer me mid-turn',
        mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
      });
      await waitUntil(() => injectedInputs.length === 2, 5_000);
      expect(injectedInputs[1]).toMatchObject({ text: 'steer me mid-turn' });
      // Steer injections skip the quiet-screen deferral (a generating screen is never quiet).
      expect(injectedInputs[1]?.scheduling.deferredUntilQuietMs).toBeUndefined();
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'safe', originKind: 'ui_pending' }),
      });
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('keeps deferring a pending web prompt mid-turn when plain capture evidence is style-unavailable', async () => {
    const abortController = createAbortableSignal();
    const injectedInputs: Array<{ text: string; scheduling: { deferredUntilQuietMs?: number | undefined } }> = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    let currentCursor: { x: number; y: number } | undefined;
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injectedInputs.push({ text: input.text, scheduling: { ...input.scheduling } });
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: currentScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseSteerMessage!: (value: { message: string; mode: EnhancedMode }) => void;
    let messageIndex = 0;
    const nextMessage = vi.fn((): Promise<{ message: string; mode: EnhancedMode } | null> => {
      messageIndex += 1;
      if (messageIndex === 1) {
        return Promise.resolve({
          message: 'start the long task',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
        });
      }
      if (messageIndex === 2) {
        return new Promise<{ message: string; mode: EnhancedMode }>((resolve) => {
          releaseSteerMessage = resolve;
        });
      }
      return new Promise<{ message: string; mode: EnhancedMode } | null>(() => {});
    });

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 25,
      telemetry,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injectedInputs.length === 1, 5_000);
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      // Mid-generation screen with a visible terminal-user draft: steering must veto.
      currentScreen = [
        '✶ Forging… (42s · esc to interrupt)',
        '╭───────────────────────────────────────────────╮',
        '│ ❯ half-typed user thought                       │',
        '╰───────────────────────────────────────────────╯',
      ].join('\n');
      currentCursor = { x: 25, y: 2 };

      await waitUntil(() => nextMessage.mock.calls.length >= 2, 5_000);
      releaseSteerMessage({
        message: 'do not merge with the draft',
        mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(injectedInputs).toHaveLength(1);
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'vetoed', reason: 'capture_style_unavailable' }),
      });

      // Turn ends → the deferred prompt drains through the normal new-turn path.
      currentScreen = interactiveClaudeScreen;
      currentCursor = undefined;
      subscribedHook?.({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injectedInputs.length === 2, 5_000);
      expect(injectedInputs[1]).toMatchObject({ text: 'do not merge with the draft' });
      expect(injectedInputs[1]?.scheduling.deferredUntilQuietMs).toBe(TERMINAL_INPUT_QUIET_PERIOD_MS);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('clears a respawn-seeded predecessor leftover draft and lets the pending prompt proceed (C11, incident cmq8y3nlx)', async () => {
    const abortController = createAbortableSignal();
    const injectedInputs: Array<{ text: string }> = [];
    const specialKeysSent: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    const leftoverText = 'please continue and keep waiting for the agents until full completion';
    const leftoverDraftScreen = [
      'Some previous Claude output',
      '╭───────────────────────────────────────────────────────────────────────────╮',
      `│ > ${leftoverText} │`,
      '╰───────────────────────────────────────────────────────────────────────────╯',
    ].join('\n');
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injectedInputs.push({ text: input.text });
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: currentScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      createControlPort: vi.fn(() => ({
        hostKind: 'tmux' as const,
        sendLiteralText: vi.fn(async () => ({ status: 'sent', at: Date.now() } as const)),
        sendRawSequence: vi.fn(async () => ({ status: 'sent', at: Date.now() } as const)),
        sendSpecialKey: vi.fn(async (key: string) => {
          specialKeysSent.push(key);
          if (key === 'Escape') {
            // The leftover draft is cleared; the turn keeps generating draft-free.
            currentScreen = '✶ Forging… (42s · esc to interrupt)';
          }
          return { status: 'sent', at: Date.now() } as const;
        }),
        captureScreen: vi.fn(async () => ({
          status: 'captured',
          capture: { text: currentScreen, capturedAtMs: Date.now(), hostKind: 'tmux' as const },
        } as const)),
      })),
      dispose: vi.fn(async () => {}),
    };
    let releaseSteerMessage!: (value: { message: string; mode: EnhancedMode }) => void;
    let messageIndex = 0;
    const nextMessage = vi.fn((): Promise<{ message: string; mode: EnhancedMode } | null> => {
      messageIndex += 1;
      if (messageIndex === 1) {
        return Promise.resolve({
          message: 'start the long task',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
        });
      }
      if (messageIndex === 2) {
        return new Promise<{ message: string; mode: EnhancedMode }>((resolve) => {
          releaseSteerMessage = resolve;
        });
      }
      return new Promise<{ message: string; mode: EnhancedMode } | null>(() => {});
    });

    // C11: the registry is seeded (e.g. from the persisted prompt store after a respawn) with a
    // text THIS run never injected — the predecessor runner's leftover composer injection.
    const ownComposerTexts = createClaudeOwnComposerTextLog();
    ownComposerTexts.record(leftoverText);

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage,
      ownComposerTexts,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 25,
      telemetry,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injectedInputs.length === 1, 5_000);
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      // Mid-turn, NON-generating screen showing the predecessor's leftover draft.
      currentScreen = leftoverDraftScreen;

      await waitUntil(() => nextMessage.mock.calls.length >= 2, 5_000);
      releaseSteerMessage({
        message: 'steer past the predecessor leftover',
        mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
      });

      // The seeded registry classifies the draft as OUR OWN residue → bounded Escape clear →
      // re-evaluation steers the pending prompt instead of starving it.
      await waitUntil(() => injectedInputs.length === 2, 10_000);
      expect(specialKeysSent).toContain('Escape');
      expect(injectedInputs[1]).toMatchObject({ text: 'steer past the predecessor leftover' });
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'own_draft_clear_attempted' }),
      });
      expect(telemetry.emit).not.toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'starvation_escalated' }),
      });
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('does not steer a pending prompt that changes the permission mode mid-turn', async () => {
    const abortController = createAbortableSignal();
    const injectedTexts: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injectedTexts.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: currentScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseSteerMessage!: (value: { message: string; mode: EnhancedMode }) => void;
    let messageIndex = 0;
    const nextMessage = vi.fn((): Promise<{ message: string; mode: EnhancedMode } | null> => {
      messageIndex += 1;
      if (messageIndex === 1) {
        return Promise.resolve({
          message: 'start the long task',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
        });
      }
      if (messageIndex === 2) {
        return new Promise<{ message: string; mode: EnhancedMode }>((resolve) => {
          releaseSteerMessage = resolve;
        });
      }
      return new Promise<{ message: string; mode: EnhancedMode } | null>(() => {});
    });

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 25,
      telemetry,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injectedTexts.length === 1, 5_000);
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      currentScreen = '✶ Forging… (42s · esc to interrupt)';

      // The message changes permission mode: in-flight steering must refuse it
      // (mode changes are handled by the main loop / next-prompt semantics).
      await waitUntil(() => nextMessage.mock.calls.length >= 2, 5_000);
      releaseSteerMessage({
        message: 'switch to accept edits and continue',
        mode: { permissionMode: 'acceptEdits', claudeUnifiedTerminalHost: 'tmux' },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(injectedTexts).toHaveLength(1);
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'vetoed', reason: 'permission_mode_change' }),
      });
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('does not inject after SessionStart until zellij input readiness is actually interactive', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = 'Resuming previous conversation...\nRendering transcript messages and tools...';
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: currentScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'wait for interactive zellij prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      allowFirstInputBeforeSessionStart: true,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 1_000);
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_INPUT_QUIET_PERIOD_MS + 150));
      expect(injected).toEqual([]);

      currentScreen = interactiveClaudeScreen;
      await waitUntil(() => injected.length === 1, 2_000);
      expect(injected).toEqual(['wait for interactive zellij prompt']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('injects an allowed CLI startup prompt before SessionStart when terminal input is ready', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'cli startup prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      allowFirstInputBeforeSessionStart: true,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {},
    });

    try {
      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['cli startup prompt']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('injects an allowed first prompt before transcript bridge startup completes', async () => {
    const abortController = createAbortableSignal();
    const committedKeys = createDeferred<ReadonlySet<string>>();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'first prompt while transcript starts',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      allowFirstInputBeforeSessionStart: true,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      onMessage: vi.fn(),
      loadCommittedClaudeJsonlMessageBaseline: async () => ({ keys: await committedKeys.promise, complete: true, oldestCoveredAtMs: null }),
    });

    try {
      await waitUntil(() => injected.length === 1, 2_500);
      expect(injected).toEqual(['first prompt while transcript starts']);
    } finally {
      committedKeys.resolve(new Set());
      abortController.abort();
      await sessionPromise;
    }
  });

  it('does not miss SessionStart emitted while the terminal host is being created', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-early-hook-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_early_hook.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant_seen_before_controller_run',
      sessionId: 'sess_early_hook',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'written before bridge startup' }],
      },
    })}\n`);

    const abortController = createAbortableSignal();
    const subscribedHooks = new Set<(data: SessionHookData) => void>();
    const onMessage = vi.fn();
    let consumed = false;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => {
        for (const callback of subscribedHooks) {
          callback({
            hook_event_name: 'SessionStart',
            session_id: 'sess_early_hook',
            transcript_path: transcriptPath,
          });
        }
        return handle;
      }),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: null,
      transcriptPath: null,
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'first prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHooks.add(callback);
        return () => {
          subscribedHooks.delete(callback);
        };
      },
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    const failFast = setTimeout(() => {
      abortController.abort();
    }, 750);

    try {
      await waitUntil(() => onMessage.mock.calls.length === 1, 1_000);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_seen_before_controller_run',
      }));
    } finally {
      clearTimeout(failFast);
      abortController.abort();
      await sessionPromise;
    }
  });

  it('starts hook and transcript bridges while terminal startup readiness is still pending', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-pending-readiness-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_pending_readiness.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant_seen_during_pending_readiness',
      sessionId: 'sess_pending_readiness',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hydrated while readiness is pending' }],
      },
    })}\n`);

    const abortController = createAbortableSignal();
    const subscribedHooks = new Set<(data: SessionHookData) => void>();
    const onMessage = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'deferred', reason: 'pane_initializing' } as const)),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: false, currentInput: 'user is typing', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: null,
      transcriptPath: null,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal: abortController.signal,
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHooks.add(callback);
        return () => {
          subscribedHooks.delete(callback);
        };
      },
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => subscribedHooks.size > 0 && (adapter.captureInputState as ReturnType<typeof vi.fn>).mock.calls.length > 0, 1_000);
      for (const callback of subscribedHooks) {
        callback({
          hook_event_name: 'SessionStart',
          session_id: 'sess_pending_readiness',
          transcript_path: transcriptPath,
        });
      }

      await waitUntil(() => onMessage.mock.calls.length === 1, 1_000);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_seen_during_pending_readiness',
      }));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('does not abort when the first prompt is accepted before startup readiness sees an idle prompt', async () => {
    const previousStartupReadinessTimeout = process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS;
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS = '250';
    reloadConfiguration();

    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: currentScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settled: { status: 'fulfilled' } | { status: 'rejected'; error: unknown } | undefined;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'accepted before idle readiness',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      allowFirstInputBeforeSessionStart: true,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      lifecycleCompletionQuiescenceMs: 0,
    });
    const observedSession = sessionPromise
      .then(() => {
        settled = { status: 'fulfilled' };
      })
      .catch((error: unknown) => {
        settled = { status: 'rejected', error };
      });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 1_000);
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 1_000);
      currentScreen = 'Claude is working on your request';
      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBeUndefined();
    } finally {
      abortController.abort();
      await observedSession;
      if (previousStartupReadinessTimeout === undefined) {
        delete process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS = previousStartupReadinessTimeout;
      }
      reloadConfiguration();
    }
  });

  it('surfaces a structured readiness-timeout error with diagnostics for a live host that never reaches an interactive prompt (D18 remote/daemon class)', async () => {
    const previousEnv = {
      timeout: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS,
      extended: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_EXTENDED_TIMEOUT_MS,
      grace: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_PROGRESS_GRACE_MS,
      poll: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_POLL_MS,
    };
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS = '250';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_EXTENDED_TIMEOUT_MS = '700';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_PROGRESS_GRACE_MS = '250';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_POLL_MS = '25';
    reloadConfiguration();

    const abortController = createAbortableSignal();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const stableUnknownScreen = 'Initializing Claude Code…\nLoading workspace configuration';
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: stableUnknownScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      allowFirstInputBeforeSessionStart: true,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'first turn never delivered',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'zellij' },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      lifecycleCompletionQuiescenceMs: 0,
    });
    const observed = sessionPromise.then(() => null, (error: unknown) => error);

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 1_000);
      // SessionStart proves the host is alive but does NOT make the composer interactive.
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      const error = await observed;
      expect(isClaudeUnifiedTerminalReadinessTimeoutError(error)).toBe(true);
      const diagnostics = (error as ClaudeUnifiedTerminalReadinessTimeoutError).diagnostics;
      expect(diagnostics?.hostAlive).toBe(true);
      expect(diagnostics?.sessionStartObserved).toBe(true);
      expect(diagnostics?.lastLivenessPaneAlive).toBe(true);
      expect(diagnostics?.lastScreenTail).toContain('Initializing Claude Code');
      expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await observed;
      restoreReadinessEnv(previousEnv);
    }
  });

  it('extends the startup window for a slow-but-progressing live host and injects once the interactive prompt renders (D18 adaptive window)', async () => {
    const previousEnv = {
      timeout: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS,
      extended: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_EXTENDED_TIMEOUT_MS,
      grace: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_PROGRESS_GRACE_MS,
      poll: process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_POLL_MS,
    };
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_TIMEOUT_MS = '250';
    // Generous extended/grace budgets: the behavior under test is "base window exceeded while
    // progressing → still injects" (capture #16 cannot arrive before 16×25ms > 250ms base), and a
    // tight extended budget made the test flaky on slow runners (16 polls + overhead vs 1500ms).
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_EXTENDED_TIMEOUT_MS = '30000';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_PROGRESS_GRACE_MS = '5000';
    process.env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_STARTUP_READINESS_POLL_MS = '25';
    reloadConfiguration();

    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let captures = 0;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => {
        captures += 1;
        // Progressing (each render differs) past the base window, then the interactive composer renders.
        if (captures < 16) {
          return { stable: true, currentInput: `Rendering transcript chunk ${captures} of many…`, observedAt: Date.now() };
        }
        return { stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() };
      }),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      allowFirstInputBeforeSessionStart: true,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'delivered after slow render',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'zellij' },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => injected.length === 1, 30_000);
      expect(injected).toEqual(['delivered after slow render']);
      expect(captures).toBeGreaterThanOrEqual(16);
    } finally {
      abortController.abort();
      await sessionPromise;
      restoreReadinessEnv(previousEnv);
    }
  });

  it('fails closed when the selected terminal host is unavailable', async () => {
    const telemetry = { emit: vi.fn() };

    await expect(
      runClaudeUnifiedTerminalSession({
        path: '/workspace/project',
        nextMessage: async () => ({
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        }),
        resolveHostAdapter: async () => ({
          status: 'disabled',
          reason: 'windows_arm64_unsupported',
          message: 'No supported terminal host is available.',
        }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        telemetry,
      }),
    ).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_unavailable',
    });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_resolved',
      properties: {
        kind: 'disabled',
        platform: process.platform,
        preference: 'zellij',
        reason: 'windows_arm64_unsupported',
      },
    });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.windows_guard_triggered',
      properties: {
        guard: 'windows_arm64_unsupported',
        hostKind: 'zellij',
        platform: 'win32',
      },
    });
  });

  it('emits Windows guard telemetry when native Windows zellij is disabled as unvalidated', async () => {
    const telemetry = { emit: vi.fn() };

    await expect(
      runClaudeUnifiedTerminalSession({
        path: '/workspace/project',
        nextMessage: async () => ({
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        }),
        resolveHostAdapter: async () => ({
          status: 'disabled',
          reason: 'windows_zellij_unvalidated',
          message: 'Bundled zellij is not validated on native Windows.',
        }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        telemetry,
      }),
    ).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_unavailable',
    });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.windows_guard_triggered',
      properties: {
        guard: 'windows_zellij_unvalidated',
        hostKind: 'zellij',
        platform: 'win32',
      },
    });
  });

  it('emits host-dead telemetry when a resolved terminal host dies before startup bridges run', async () => {
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const liveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 127,
      observedAt: 123,
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(),
      evaluateLiveness: vi.fn(async () => liveness),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await expect(
      runClaudeUnifiedTerminalSession({
        path: '/workspace/project',
        nextMessage: async () => ({
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        }),
        resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-session-test',
        telemetry,
        initialHostLivenessTimeoutMs: 1,
        initialHostLivenessPollMs: 1,
      }),
    ).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness,
    });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_dead',
      properties: {
        hostKind: 'zellij',
        sessionName: 'happier-claude-session-test',
        paneId: 'terminal_1',
        paneAlive: false,
        paneDead: true,
        paneCurrentCommand: '/managed/node',
        paneExitStatus: 127,
        observedAt: 123,
      },
    });
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('removes an unread launch spec when terminal host creation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-unified-launch-spec-fail-'));
    tempDirs.push(dir);
    const specPath = join(dir, 'launch.json');
    await writeFile(specPath, JSON.stringify({ command: '/bin/claude', args: [], cwd: dir, env: {} }), { mode: 0o600 });
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        throw new Error('tmux failed before launching runner');
      }),
      injectUserPrompt: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', specPath],
        spawnEnv: {},
        launchSpecPath: specPath,
      }),
      createSessionName: () => 'happier-claude-session-test',
    })).rejects.toThrow('tmux failed before launching runner');

    expect(existsSync(specPath)).toBe(false);
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('does not subscribe to Claude hooks before launch spec construction succeeds', async () => {
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let subscriptions = 0;

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => {
        throw new Error('launch spec failed');
      },
      subscribeClaudeSessionHooks: () => {
        subscriptions += 1;
        return () => {};
      },
    })).rejects.toThrow('launch spec failed');

    expect(subscriptions).toBe(0);
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('treats prompt-input SessionEnd followed by clean terminal exit as graceful shutdown', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    let paneAlive = true;
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      evaluateLiveness: vi.fn(async () => (paneAlive
        ? { paneAlive: true, observedAt: Date.now() }
        : {
            paneAlive: false,
            paneDead: true,
            paneCurrentCommand: '/managed/node',
            paneExitStatus: 0,
            observedAt: Date.now(),
          })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      telemetry,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      hook({
        hook_event_name: 'SessionEnd',
        session_id: 'claude-session-id',
        reason: 'prompt_input_exit',
      });
      paneAlive = false;

      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 1_200);
        }),
      ]);

      expect(result).toEqual({ kind: 'resolved' });
      expect(telemetry.emit).not.toHaveBeenCalledWith(expect.objectContaining({
        name: 'unified.session.host_dead',
      }));
      expect(adapter.dispose).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('fails instead of waiting forever when the terminal host stays dead after prompt injection', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let paneAlive = true;
    let deadLivenessCalls = 0;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => {
        if (!paneAlive) deadLivenessCalls += 1;
        return { paneAlive, observedAt: Date.now() };
      }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
        resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-session-test',
        telemetry,
      });

    try {
      await waitUntil(() => injected.length === 1);
      paneAlive = false;
      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 3_000);
        }),
      ]);

      expect(result).toMatchObject({
        kind: 'error',
        error: {
          code: 'claude_unified_terminal_host_dead',
        },
      });
      expect(deadLivenessCalls).toBeGreaterThanOrEqual(2);
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.session.host_dead',
        properties: {
          hostKind: 'zellij',
          sessionName: 'happier-claude-session-test',
          paneId: 'terminal_1',
          paneAlive: false,
          observedAt: expect.any(Number),
        },
      });
      expect(adapter.dispose).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('hands a message consumed during the host-death unwind back to the owner instead of dropping it (silent queue-swallow fix)', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let paneAlive = true;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'zellij',
    } as const;
    let nextMessageCallCount = 0;
    let consumed = false;
    let resolveSecondMessage!: (value: { message: string; mode: typeof mode }) => void;
    const secondMessage = new Promise<{ message: string; mode: typeof mode }>((resolve) => {
      resolveSecondMessage = resolve;
    });
    const returnUnconsumedMessage = vi.fn();
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        nextMessageCallCount += 1;
        if (!consumed) {
          consumed = true;
          return { message: 'hello', mode };
        }
        return await secondMessage;
      },
      returnUnconsumedMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => injected.length === 1);
      paneAlive = false;
      await expect(sessionPromise).rejects.toMatchObject({
        code: 'claude_unified_terminal_host_dead',
      });

      // The injected-but-never-provider-accepted batch is handed back by the arbiter on the
      // unwind (F-1: duplicate-attempt is the safe direction; dedupe absorbs it). If the pump
      // has not prefetched the next message yet, it remains owner-held instead of needing a
      // second handback.
      resolveSecondMessage({ message: 'arrived during unwind', mode });
      await waitUntil(() => returnUnconsumedMessage.mock.calls.length === 1);
      expect(returnUnconsumedMessage).toHaveBeenNthCalledWith(1, {
        message: 'hello',
        mode,
        maxUserMessageSeq: null,
        userMessageLocalIds: [],
      });
      expect(nextMessageCallCount).toBe(1);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('hands a batch parked inside the arbiter on a failed_terminal injection back to the owner (F-1 park drop)', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'no_target' as const,
        phase: 'before_write' as const,
        duplicateRisk: 'none' as const,
        recoverable: false,
      })),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'zellij',
    } as const;
    let consumed = false;
    const returnUnconsumedMessage = vi.fn();
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (!consumed) {
          consumed = true;
          return { message: 'doomed prompt', mode };
        }
        return await new Promise(() => undefined);
      },
      returnUnconsumedMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await expect(sessionPromise).rejects.toMatchObject({
        name: 'ClaudeUnifiedTerminalInjectionFailureError',
      });

      // The failed_terminal batch was still inside the arbiter queue when the runtime
      // unwound; the park/relaunch flow must receive it back instead of losing it.
      expect(returnUnconsumedMessage).toHaveBeenCalledWith({
        message: 'doomed prompt',
        mode,
        maxUserMessageSeq: null,
        userMessageLocalIds: [],
      });
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces invalid prompt text without returning it to the owner for relaunch', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({
        status: 'injected' as const,
        at: Date.now(),
        bytesWritten: 1,
      })),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'zellij',
    } as const;
    let consumed = false;
    const returnUnconsumedMessage = vi.fn();
    const onTerminalInjectionFailure = vi.fn();
    const onPromptTerminallyRejectedBeforeProvider = vi.fn();
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (!consumed) {
          consumed = true;
              return { message: 'bad\u0000prompt', mode, maxUserMessageSeq: 73 };
        }
        return await new Promise(() => undefined);
      },
      returnUnconsumedMessage,
      onTerminalInjectionFailure,
      onPromptTerminallyRejectedBeforeProvider,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => onTerminalInjectionFailure.mock.calls.length === 1);

      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
        reason: 'invalid_prompt_text',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
      }));
      expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
      expect(returnUnconsumedMessage).not.toHaveBeenCalled();
      expect(onPromptTerminallyRejectedBeforeProvider).toHaveBeenCalledWith({
        message: 'bad\u0000prompt',
        maxUserMessageSeq: 73,
        userMessageLocalIds: [],
        reason: 'invalid_prompt_text',
      });
    } finally {
      abortController.abort();
      await expect(sessionPromise).resolves.toBeUndefined();
    }
  });

  it('fails instead of waiting forever when terminal liveness becomes unreachable after prompt injection', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let livenessCalls = 0;
    let throwOnLiveness = false;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => {
        livenessCalls += 1;
        if (throwOnLiveness) {
          // Thrown probes are INCONCLUSIVE by adapter contract (the real zellij adapter converts
          // conclusive "no active session" results into paneDead observations instead of throwing).
          throw new Error('zellij list-panes timed out');
        }
        return { paneAlive: true, observedAt: Date.now() };
      }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      // Sustained probe-failure streaks (not isolated timeouts) must still fail the session
      // instead of waiting forever; shrink the streak window so the test observes it quickly.
      hostLivenessProbeFailureConfirmDeadMs: 1_200,
      telemetry,
    });

    try {
      await waitUntil(() => injected.length === 1);
      const callsBeforeFailure = livenessCalls;
      throwOnLiveness = true;
      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 4_000);
        }),
      ]);

      expect(livenessCalls).toBeGreaterThan(callsBeforeFailure);
      expect(result).toMatchObject({
        kind: 'error',
        error: {
          code: 'claude_unified_terminal_host_dead',
        },
      });
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.session.host_dead',
        properties: expect.objectContaining({
          hostKind: 'zellij',
          sessionName: 'happier-claude-session-test',
          paneId: 'terminal_1',
        }),
      });
      expect(adapter.dispose).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('survives a single transient terminal liveness probe failure after prompt injection', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let throwRemaining = 0;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => {
        if (throwRemaining > 0) {
          throwRemaining -= 1;
          throw new Error('zellij list-panes failed: transient timeout');
        }
        return { paneAlive: true, observedAt: Date.now() };
      }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => injected.length === 1);
      throwRemaining = 1;
      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 1_500);
        }),
      ]);

      expect(result).toEqual({ kind: 'timeout' });
      expect(telemetry.emit).not.toHaveBeenCalledWith(expect.objectContaining({
        name: 'unified.session.host_dead',
      }));
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces ambiguous provider acceptance timeouts without aborting the terminal host', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onTerminalInjectionFailure = vi.fn();
    const returnUnconsumedMessage = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const options = {
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 20,
      onTerminalInjectionFailure,
    } satisfies Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      providerAcceptanceTimeoutMs: number;
      onTerminalInjectionFailure: typeof onTerminalInjectionFailure;
    };
    const sessionPromise = runClaudeUnifiedTerminalSession(options)
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => injected.length === 1);
      await waitUntil(() => onTerminalInjectionFailure.mock.calls.length > 0 || settlement !== null, 6_000);

      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_ambiguous',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
      }));
      expect(settlement).toBeNull();
      expect(adapter.dispose).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('surfaces an injected pending prompt when the terminal turn fails before provider confirmation', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onTerminalInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const returnUnconsumedMessage = vi.fn();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'windows_console',
      sessionName: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'windows_console',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'terminal failed before provider confirmation',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'auto',
          },
          maxUserMessageSeq: 984,
          userMessageLocalIds: ['pending-local-terminal-end-failed'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['claude.exe'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 60_000,
      onTerminalInjectionFailure,
      returnUnconsumedMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    })
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
      });
      await waitUntil(() => injected.length === 1, 5_000);

      subscribedHook?.({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
      });

      await waitUntil(() => onTerminalInjectionFailure.mock.calls.length === 1 || settlement !== null, 500);
      expect(settlement).toBeNull();
      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
        maxUserMessageSeq: 984,
        userMessageLocalIds: ['pending-local-terminal-end-failed'],
      }));
      expect(adapter.dispose).not.toHaveBeenCalled();
      expect(returnUnconsumedMessage).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces an injected Windows-console pending prompt when the failed terminal boundary arrives after pending delivery drains', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onTerminalInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const onPromptAcceptedByProvider = vi.fn();
    const returnUnconsumedMessage = vi.fn();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let pendingDeliveryDrainedWithoutProviderAcceptance = false;
    const handle: TerminalHostHandle = {
      kind: 'windows_console',
      sessionName: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'windows_console',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'terminal failed after pending delivery drained',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'auto',
          },
          maxUserMessageSeq: 985,
          userMessageLocalIds: ['pending-local-terminal-end-drained'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['claude.exe'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 60_000,
      isPromptDeliveryAccepted: () => pendingDeliveryDrainedWithoutProviderAcceptance,
      onPromptAcceptedByProvider,
      onTerminalInjectionFailure,
      returnUnconsumedMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    })
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
      });
      await waitUntil(() => injected.length === 1, 5_000);

      pendingDeliveryDrainedWithoutProviderAcceptance = true;
      subscribedHook?.({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
      });

      await waitUntil(() => onTerminalInjectionFailure.mock.calls.length === 1 || settlement !== null, 500);
      expect(settlement).toBeNull();
      expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
        maxUserMessageSeq: 985,
        userMessageLocalIds: ['pending-local-terminal-end-drained'],
      }));
      expect(adapter.dispose).not.toHaveBeenCalled();
      expect(returnUnconsumedMessage).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces Windows-console host loss after Enter when the injection outcome is recorded', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const onTerminalInjectionFailure = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'windows_console',
      sessionName: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const injectUserPrompt = vi.fn(async () => ({
      status: 'failed' as const,
      reason: 'host_unreachable' as const,
      phase: 'after_enter_unknown' as const,
      duplicateRisk: 'possible' as const,
      recoverable: true,
    }));
    const adapter: TerminalHostAdapter = {
      kind: 'windows_console',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'windows console submit failure should be surfaced',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'auto',
          },
          maxUserMessageSeq: 971,
          userMessageLocalIds: ['windows-submit-failure-local-id'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['claude.exe'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 5_000,
      telemetry,
      onTerminalInjectionFailure,
    })
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => injectUserPrompt.mock.calls.length === 1, 5_000);
      await waitUntil(() => telemetry.emit.mock.calls.some((call) => call[0]?.name === 'unified.injection.outcome'), 1_000);

      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.outcome',
        properties: expect.objectContaining({
          status: 'failed',
          reason: 'host_unreachable',
          phase: 'after_enter_unknown',
          duplicateRisk: 'possible',
          hostKind: 'windows_console',
          originKind: 'ui_pending',
        }),
      });
      await waitUntil(() => onTerminalInjectionFailure.mock.calls.length === 1 || settlement !== null, 500);

      expect(settlement).toBeNull();
      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_ambiguous',
        reason: 'host_unreachable',
        phase: 'after_enter_unknown',
        duplicateRisk: 'possible',
        recoverable: true,
        userMessageLocalIds: ['windows-submit-failure-local-id'],
      }));
      expect(injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces Windows-console host loss after Enter as a runtime issue without handing the failed batch back', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    const failTurn = vi.fn(async () => {});
    const returnUnconsumedMessage = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'windows_console',
      sessionName: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const injectUserPrompt = vi.fn(async () => ({
      status: 'failed' as const,
      reason: 'host_unreachable' as const,
      phase: 'after_enter_unknown' as const,
      duplicateRisk: 'possible' as const,
      recoverable: true,
    }));
    const adapter: TerminalHostAdapter = {
      kind: 'windows_console',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const sessionForRuntimeIssue = {
      sessionTurnLifecycle: {
        beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
        completeTurn: vi.fn(async () => {}),
        cancelTurn: vi.fn(async () => {}),
        failTurn,
      },
    } as unknown as Parameters<typeof surfaceClaudeUnifiedTerminalRuntimeIssue>[0]['session'];
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'windows console submit failure should fail the visible turn once',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'auto',
          },
          maxUserMessageSeq: 972,
          userMessageLocalIds: ['windows-submit-failure-runtime-local-id'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['claude.exe'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 5_000,
      telemetry,
      returnUnconsumedMessage,
      onTerminalInjectionFailure: async (error) => {
        await surfaceClaudeUnifiedTerminalRuntimeIssue({
          error,
          session: sessionForRuntimeIssue,
        });
      },
    })
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => injectUserPrompt.mock.calls.length === 1, 5_000);
      await waitUntil(() => failTurn.mock.calls.length === 1 || settlement !== null, 1_000);

      expect(settlement).toBeNull();
      expect(failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_session_error',
          source: 'provider_session_error',
          provider: 'claude',
        }),
        allocateWhenIdle: true,
      });
      expect(injectUserPrompt).toHaveBeenCalledTimes(1);

      abortController.abort();
      await sessionPromise.catch(() => undefined);

      expect(returnUnconsumedMessage).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces exhausted ambiguous provider acceptance without aborting the live terminal runtime', async () => {
    // A live host with an injected ui_pending prompt whose provider acceptance times out twice is
    // unresolved delivery debt, not a terminal/process death. Surface the classified failure so the
    // pending-delivery owner can block or retry safely, but keep the runtime alive until explicitly
    // stopped.
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onTerminalInjectionFailure = vi.fn();
    const returnUnconsumedMessage = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'steered prompt never accepted',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 20,
      onTerminalInjectionFailure,
      returnUnconsumedMessage,
    })
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => injected.length >= 1);
      await waitUntil(
        () => onTerminalInjectionFailure.mock.calls.some((call) => call[0]?.failureState === 'failed_terminal') || settlement !== null,
        6_000,
      );

      expect(settlement).toBeNull();
      expect(adapter.dispose).not.toHaveBeenCalled();
      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_ambiguous',
      }));
      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
          code: 'claude_unified_terminal_injection_failed',
          failureState: 'failed_terminal',
          reason: 'timeout',
      }));
      expect(injected.length).toBe(2);
      expect(returnUnconsumedMessage).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('credits provider acceptance when terminal custody owns a steered prompt before turn end', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    const onTerminalInjectionFailure = vi.fn();
    const onPromptAcceptedByProvider = vi.fn();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let currentScreen = interactiveClaudeScreen;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        if (input.text === 'terminal custody loses acceptance proof') {
          currentScreen = [
            '✶ Forging… (44s · esc to interrupt)',
            '  Press up to edit queued messages',
          ].join('\n');
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: currentScreen, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseSteerMessage!: (value: { message: string; mode: EnhancedMode }) => void;
    let messageIndex = 0;
    const nextMessage = vi.fn((): Promise<{ message: string; mode: EnhancedMode } | null> => {
      messageIndex += 1;
      if (messageIndex === 1) {
        return Promise.resolve({
          message: 'start long task',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' } satisfies EnhancedMode,
        });
      }
      if (messageIndex === 2) {
        return new Promise<{ message: string; mode: EnhancedMode }>((resolve) => {
          releaseSteerMessage = resolve;
        });
      }
      return new Promise<{ message: string; mode: EnhancedMode } | null>(() => {});
    });
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-session-test',
      lifecycleCompletionQuiescenceMs: 0,
      providerAcceptanceTimeoutMs: 20,
      telemetry,
      onTerminalInjectionFailure,
      onPromptAcceptedByProvider,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    })
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);
      subscribedHook?.({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      currentScreen = [
        '● Working through the task…',
        '✶ Forging… (42s · esc to interrupt)',
      ].join('\n');
      await waitUntil(() => nextMessage.mock.calls.length >= 2, 5_000);
      releaseSteerMessage({
        message: 'terminal custody loses acceptance proof',
        mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
      });
      await waitUntil(() => injected.length === 2, 5_000);
      await waitUntil(() => telemetry.emit.mock.calls.some((call) => (
        call[0]?.name === 'unified.steer.decision'
        && call[0]?.properties?.decision === 'queued_banner_check'
        && call[0]?.properties?.queuedBannerVisible === true
      )), 5_000);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.some((call) => (
        call[0]?.message === 'terminal custody loses acceptance proof'
      )), 5_000);

      subscribedHook?.({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(settlement).toBeNull();
      expect(adapter.dispose).not.toHaveBeenCalled();
      expect(onTerminalInjectionFailure).not.toHaveBeenCalledWith(expect.objectContaining({
        failureState: 'failed_terminal',
      }));
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('uses Claude session hooks to redrain queued prompts after a terminal turn completes', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const events: string[] = [];
    let resolveReady: (() => void) | undefined;
    const onThinkingChange = vi.fn();
    const onReady = vi.fn(() => new Promise<void>((resolve) => {
      events.push('ready-start');
      resolveReady = () => {
        events.push('ready-finished');
        resolve();
      };
    }));
    const onMessage = vi.fn((message: RawJSONLines) => {
      const uuid = typeof (message as Record<string, unknown>).uuid === 'string'
        ? (message as Record<string, unknown>).uuid
        : 'unknown';
      events.push(`message:${uuid}`);
    });
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        events.push(`inject:${input.text}`);
        injected.push(input.text);
        if (input.text === 'second') {
          abortController.abort();
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const firstMessage: Readonly<{ message: string; mode: EnhancedMode }> = {
      message: 'first',
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    };
    const secondMessage: Readonly<{ message: string; mode: EnhancedMode }> = {
      message: 'second',
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    };
    let firstMessageConsumed = false;
    let secondMessageConsumed = false;
    let resolveSecondMessage: (() => void) | undefined;
    const secondMessageReady = new Promise<void>((resolve) => {
      resolveSecondMessage = resolve;
    });

    const options: Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      onThinkingChange: typeof onThinkingChange;
      onReady: typeof onReady;
    } = {
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (!firstMessageConsumed) {
          firstMessageConsumed = true;
          return firstMessage;
        }
        if (!secondMessageConsumed) {
          await secondMessageReady;
          secondMessageConsumed = true;
          return secondMessage;
        }
        return null;
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onThinkingChange,
      onReady,
      lifecycleCompletionQuiescenceMs: 0,
    };

    const sessionPromise = runClaudeUnifiedTerminalSession(options);

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['first']);

      hook({ hook_event_name: 'UserPromptSubmit' });
      expect(onThinkingChange).toHaveBeenLastCalledWith(true);
      hook({ hook_event_name: 'Stop' });

      await waitUntil(() => onReady.mock.calls.length === 1, 5_000);
      resolveSecondMessage?.();
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_INPUT_QUIET_PERIOD_MS + 50));
      expect(injected).toEqual(['first']);
      resolveReady?.();
      await waitUntil(() => injected.length === 2, 5_000);
      expect(injected).toEqual(['first', 'second']);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(events.indexOf('ready-finished')).toBeLessThan(events.indexOf('inject:second'));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('fires onPromptAcceptedByProvider with the batch watermark seq only at provider acceptance (A3-HIGH-1)', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onPromptAcceptedByProvider = vi.fn();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (!consumed) {
          consumed = true;
          return {
            message: 'watermarked prompt',
            mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
            maxUserMessageSeq: 42,
          };
        }
        return await new Promise(() => undefined);
      },
      onPromptAcceptedByProvider,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('hook subscription missing');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);

      // Injection alone is NOT provider acceptance: the watermark must not be confirmed yet.
      expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();

      hook({ hook_event_name: 'UserPromptSubmit' });
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1, 5_000);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: 'watermarked prompt',
        maxUserMessageSeq: 42,
        userMessageLocalIds: [],
      });
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('notifies only successfully injected prompts as accepted by the terminal runtime', async () => {
    const abortController = createAbortableSignal();
    const onTerminalPromptInjected = vi.fn();
    const acceptedMode: EnhancedMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: 5 } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const options: Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      onTerminalPromptInjected: typeof onTerminalPromptInjected;
    } = {
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'accepted',
        mode: acceptedMode,
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      onTerminalPromptInjected,
    };

    await runClaudeUnifiedTerminalSession(options);

    expect(onTerminalPromptInjected).toHaveBeenCalledTimes(1);
    expect(onTerminalPromptInjected).toHaveBeenCalledWith({
      message: 'accepted',
      mode: acceptedMode,
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
  });

  it('forwards terminal-originated UserPromptSubmit hooks as provider prompt starts', async () => {
    const abortController = createAbortableSignal();
    const onProviderPromptStarted = vi.fn();
    const injected: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const messages: Array<{ message: string; mode: EnhancedMode }> = [
      {
        message: 'first',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      },
    ];
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => messages.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onProviderPromptStarted,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });

      expect(onProviderPromptStarted).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('registers terminal host interruption as the remote turn interrupt handler', async () => {
    const abortController = createAbortableSignal();
    let interruptHandler: (() => Promise<void>) | null | undefined;
    const setTurnInterrupt = vi.fn((handler: (() => Promise<void>) | null) => {
      interruptHandler = handler;
    });
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      interruptTurn: vi.fn(async () => {}),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: interactiveClaudeScreen, observedAt: Date.now() })),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      signal: abortController.signal,
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      setTurnInterrupt,
      createController: () => ({
        run: async () => {},
        dispose: async () => {},
      }),
    });

    try {
      await waitUntil(() => typeof interruptHandler === 'function');
      await interruptHandler?.();
      expect(adapter.interruptTurn).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
    expect(setTurnInterrupt).toHaveBeenLastCalledWith(null);
  });

  it('uses transcript turn signals to mark completion and drain the next queued prompt', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-transcript-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_transcript.jsonl');
    await writeFile(transcriptPath, '');

    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onThinkingChange = vi.fn();
    const events: string[] = [];
    const onReady = vi.fn(() => {
      events.push('ready');
    });
    const onMessage = vi.fn((message: RawJSONLines) => {
      const uuid = typeof (message as Record<string, unknown>).uuid === 'string'
        ? (message as Record<string, unknown>).uuid
        : 'unknown';
      events.push(`message:${uuid}`);
    });
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        if (input.text === 'second') {
          abortController.abort();
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode: EnhancedMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const messages = [
      { message: 'first', mode },
      { message: 'second', mode },
    ];

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: 'sess_transcript',
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => messages.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onThinkingChange,
      onReady,
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'sess_transcript',
        transcript_path: transcriptPath,
      });
      await waitUntil(() => injected.length === 1);
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'user_1',
        message: { content: 'first' },
      })}\n`);
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant_1',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
        },
      })}\n`);

      await waitUntil(() => injected.length === 2, 5_000);
      expect(injected).toEqual(['first', 'second']);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_1',
      }));
      expect(events).toEqual(expect.arrayContaining(['message:assistant_1', 'ready']));
      expect(events.indexOf('message:assistant_1')).toBeLessThan(events.indexOf('ready'));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('uses compact boundary transcript signals to complete standalone compact turns and drain queued prompts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-compact-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_compact.jsonl');
    await writeFile(transcriptPath, '');

    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onThinkingChange = vi.fn();
    const onReady = vi.fn();
    const onMessage = vi.fn();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        if (input.text === 'follow-up after compact') {
          abortController.abort();
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode: EnhancedMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const messages = [
      { message: '/compact', mode },
      { message: 'follow-up after compact', mode },
    ];

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: 'sess_compact',
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => messages.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onThinkingChange,
      onReady,
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'sess_compact',
        transcript_path: transcriptPath,
      });
      await waitUntil(() => injected.length === 1);
      expect(injected).toEqual(['/compact']);

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'compact_command_marker',
        message: {
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      })}\n`);
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'system',
        uuid: 'compact_boundary_1',
        subtype: 'compact_boundary',
        session_id: 'sess_compacted',
      })}\n`);

      await waitUntil(() => injected.length === 2, 5_000);
      expect(injected).toEqual(['/compact', 'follow-up after compact']);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

});

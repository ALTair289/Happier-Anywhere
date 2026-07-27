import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { EnhancedMode } from './loop';

const mockQuery = vi.fn();

vi.mock('@/backends/claude/sdk', () => ({
  query: mockQuery,
  AbortError: class AbortError extends Error {},
}));

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('./utils/remoteSystemPrompt', () => ({
  getClaudeRemoteSystemPrompt: () => 'REMOTE_PROMPT',
}));

vi.mock('./utils/ensureClaudeJsRuntimeExecutable', () => ({
  ensureClaudeJsRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('./utils/resolveClaudeCliPath', () => ({
  resolveClaudeCliPath: vi.fn(() => '/resolved/claude-cli.js'),
}));

type RemoteOptions = Parameters<(typeof import('./claudeRemote'))['claudeRemote']>[0];
type QueryConfig = Readonly<{
  prompt: AsyncIterable<SDKUserMessage>;
  onPromptTransportOutcome?: (
    message: SDKUserMessage,
    outcome: 'accepted' | 'rejected_before_effect' | 'effect_may_have_occurred',
  ) => void;
}>;

function defaultMode(): EnhancedMode {
  return { permissionMode: 'default' };
}

function createOptions(overrides?: Partial<RemoteOptions>): RemoteOptions {
  let didReadInitial = false;
  return {
    sessionId: null,
    transcriptPath: null,
    path: '/tmp',
    hookSettingsPath: '/tmp/hooks.json',
    canCallTool: vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} })),
    isAborted: () => false,
    nextMessage: async () => {
      if (didReadInitial) return null;
      didReadInitial = true;
      return {
        message: 'exact queued prompt',
        mode: defaultMode(),
        maxUserMessageSeq: 17,
        userMessageLocalIds: ['local-17'],
      };
    },
    onReady: vi.fn(),
    onSessionFound: vi.fn(),
    onMessage: vi.fn(),
    ...overrides,
  };
}

describe('claudeRemote provider transport boundary', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('does not accept the queued prompt until the exact stdin transport write succeeds', async () => {
    const onPromptAcceptedByProvider = vi.fn();
    let queryConfig: QueryConfig | null = null;

    mockQuery.mockImplementation((rawConfig: QueryConfig) => {
      queryConfig = rawConfig;
      return {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
          throw new Error('stop before SDK prompt consumption');
        },
      };
    });

    const { claudeRemote } = await import('./claudeRemote');
    await expect(claudeRemote(createOptions({
      onPromptAcceptedByProvider,
    }))).rejects.toThrow('stop before SDK prompt consumption');

    const config = queryConfig as QueryConfig | null;
    if (!config) throw new Error('expected query config');
    const consumed = await config.prompt[Symbol.asyncIterator]().next();
    if (consumed.done) throw new Error('expected exact queued SDK prompt');
    expect(consumed.value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'exact queued prompt' },
    });
    expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();

    config.onPromptTransportOutcome?.(consumed.value, 'accepted');
    expect(onPromptAcceptedByProvider).toHaveBeenCalledExactlyOnceWith({
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['local-17'],
    });
  }, 60_000);

  it('reports an attempted stdin transport failure as effect-ambiguous without acceptance', async () => {
    const onPromptAcceptedByProvider = vi.fn();
    const onPromptTransportFailure = vi.fn();
    mockQuery.mockImplementation((rawConfig: QueryConfig) => {
      const providerRead = rawConfig.prompt[Symbol.asyncIterator]().next();
      return {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
          const consumed = await providerRead;
          if (consumed.done) throw new Error('expected exact queued SDK prompt');
          rawConfig.onPromptTransportOutcome?.(consumed.value, 'effect_may_have_occurred');
          throw new Error('stdin EPIPE after write attempt');
        },
      };
    });

    const { claudeRemote } = await import('./claudeRemote');
    await expect(claudeRemote(createOptions({
      onPromptAcceptedByProvider,
      onPromptTransportFailure,
    } as Partial<RemoteOptions>))).rejects.toThrow('stdin EPIPE after write attempt');

    expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
    expect(onPromptTransportFailure).toHaveBeenCalledWith({
      kind: 'effect_may_have_occurred',
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['local-17'],
    });
  });

  it('does not accept when the SDK rejects before consuming the queued prompt', async () => {
    const acceptedLocalIds: Array<readonly string[]> = [];
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        throw new Error('SDK admission rejected before prompt consumption');
      },
    });

    const { claudeRemote } = await import('./claudeRemote');
    await expect(claudeRemote(createOptions({
      onPromptAcceptedByProvider: (acceptance) => {
        acceptedLocalIds.push(acceptance.userMessageLocalIds);
      },
    }))).rejects.toThrow('SDK admission rejected before prompt consumption');

    expect(acceptedLocalIds).toEqual([]);
  });

  it('keeps the provider prompt stream closed when Runtime Activity observer activation rejects', async () => {
    let providerReadSettled = false;
    mockQuery.mockImplementation((rawConfig: QueryConfig) => {
      void rawConfig.prompt[Symbol.asyncIterator]().next().then(() => {
        providerReadSettled = true;
      });
      return {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
          yield { type: 'result' } as SDKMessage;
        },
      };
    });
    const runtimeActivityAdapter = {
      activateObservation: vi.fn(async () => { throw new Error('observer activation failed'); }),
      observeActivity: vi.fn(async () => {}),
      publishCurrent: vi.fn(async () => {}),
      handleRuntimeLoss: vi.fn(async () => {}),
    };
    const onPromptAcceptedByProvider = vi.fn();

    const { claudeRemote } = await import('./claudeRemote');
    await expect(claudeRemote(createOptions({
      runtimeActivityAdapter,
      onPromptAcceptedByProvider,
    }))).rejects.toThrow('observer activation failed');

    await Promise.resolve();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runtimeActivityAdapter.activateObservation).toHaveBeenCalledTimes(1);
    expect(providerReadSettled).toBe(false);
    expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
  });
});

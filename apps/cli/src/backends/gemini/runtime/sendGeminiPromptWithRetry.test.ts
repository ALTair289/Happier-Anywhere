import { describe, expect, it, vi } from 'vitest';

import { sendGeminiPromptWithRetry } from './sendGeminiPromptWithRetry';

describe('sendGeminiPromptWithRetry', () => {
  it('sends prompt once when backend succeeds immediately', async () => {
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(backend.waitForResponseComplete).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('notifies provider prompt acceptance after sendPrompt resolves before response completion', async () => {
    let resolveResponseComplete!: () => void;
    const responseComplete = new Promise<void>((resolve) => {
      resolveResponseComplete = resolve;
    });
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn(async () => await responseComplete),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    let settled = false;
    const promptPromise = sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      onProviderPromptAccepted,
    }).finally(() => {
      settled = true;
    });

    try {
      await vi.waitFor(() => {
        expect(backend.waitForResponseComplete).toHaveBeenCalledTimes(1);
      });
      await Promise.resolve();

      expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      resolveResponseComplete();
      await promptPromise;
    }
  });

  it('does not pass a bounded response wait timeout by default', async () => {
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(backend.waitForResponseComplete).toHaveBeenCalledWith(null);
  });

  it('passes an explicit response wait timeout when configured', async () => {
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      waitForResponseTimeoutMs: 1234,
    });

    expect(backend.waitForResponseComplete).toHaveBeenCalledWith(1234);
  });

  it('returns the ACP turn outcome from response completion', async () => {
    const outcome = { kind: 'completed' as const, stopReason: 'end_turn' as const };
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(result).toEqual(outcome);
  });

  it('does not retry timed-out ACP turn outcomes after provider acceptance', async () => {
    const outcome = { kind: 'timed_out' as const, capMs: 120_000 };
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      onProviderPromptAccepted,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual(outcome);
    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
  });

  it('does not retry ACP max-turn stop outcomes after provider acceptance', async () => {
    const outcome = { kind: 'completed' as const, stopReason: 'max_turn_requests' as const };
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      onProviderPromptAccepted,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual(outcome);
    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
  });

  it('does not retry stall timeout failures after provider acceptance', async () => {
    const stallError = new Error('Timeout waiting for response to complete');
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockRejectedValue(stallError),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    await expect(
      sendGeminiPromptWithRetry({
        backend,
        acpSessionId: 'session-1',
        prompt: 'hello',
        messageBuffer,
        session,
        onDebug,
        onProviderPromptAccepted,
        maxRetries: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toBe(stallError);

    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
  });

  it('does not retry aborted ACP turn outcomes', async () => {
    const outcome = { kind: 'aborted' as const, stopReason: 'cancelled' as const };
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual(outcome);
    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('retries empty-response failures and eventually succeeds', async () => {
    const backend = {
      sendPrompt: vi
        .fn()
        .mockRejectedValueOnce({ details: 'Model stream ended unexpectedly' })
        .mockResolvedValueOnce(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(backend.sendPrompt).toHaveBeenCalledTimes(2);
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      'status',
    );
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('does not retry quota errors and forwards quota message to session', async () => {
    const backend = {
      sendPrompt: vi.fn().mockRejectedValue({ details: 'quota exhausted reset after 1h2m' }),
      waitForResponseComplete: vi.fn(),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await expect(
      sendGeminiPromptWithRetry({
        backend,
        acpSessionId: 'session-1',
        prompt: 'hello',
        messageBuffer,
        session,
        onDebug,
      }),
    ).rejects.toBeTruthy();

    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(
      expect.stringContaining('quota'),
      'status',
    );
    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({ type: 'message' }),
    );
  });
});
